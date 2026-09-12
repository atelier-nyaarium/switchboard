import { type Ambient, withinMs } from "../../shared/ambient.js";
import type { BoardDisposition } from "../../shared/board-authority.js";
import type { ConsoleOp } from "../../shared/console-protocol.js";
import { type HostOp, type HostOpResult, isSpawnWorkdirPath } from "../../shared/host-op.js";
import { composeSessionName } from "../../shared/session-id.js";
import { sanitizeLabel } from "../../shared/session-sanitize.js";
import type { SessionRecord, SessionStore } from "../../shared/session-store.js";
import { fireAndForget } from "../fireAndForget.js";
import type { WakeResult } from "../wake.js";
import type { ConsoleTargets } from "./consoleTargets.js";
import { CreateSessionAmbiguousError } from "./consoleTypes.js";

/**
 * Whether this Gateway launched the terminal behind a record. A session someone started themselves
 * runs under a name no target derives, so close refuses it and forget leaves it alone.
 */
export function ownTerminal(record: SessionRecord | undefined, teamOf: (record: SessionRecord) => string): boolean {
	return !record?.liveTeam || record.liveTeam.team === teamOf(record);
}

export interface SessionLifecycleDeps {
	targets: ConsoleTargets;
	createSessionBoundMs: number;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	tryWakeTeam?: (team: string) => Promise<WakeResult>;
	isWakeInFlight?: (team: string) => boolean;
	joinCreate?: (
		team: string,
		start: () => Promise<HostOpResult>,
	) => { launch: Promise<HostOpResult>; release: (() => void) | null };
	awaitRegister?: (team: string) => Promise<WakeResult>;
	dropSessionResume?: (team: string, boardDisposition: BoardDisposition) => void;
	/** Close and forget end session grants. */
	onSessionEnded?: (team: string) => void;
	sessionStore?: Pick<
		SessionStore,
		| "getByTeam"
		| "teamOf"
		| "adoptById"
		| "adoptOrReattach"
		| "mintOrReattach"
		| "hostWorkdirHint"
		| "forget"
		| "rename"
		| "ensureBindToken"
	>;
}

export function createSessionLifecycleHandlers({
	targets,
	createSessionBoundMs,
	ambient,
	relayToHost,
	tryWakeTeam,
	isWakeInFlight,
	joinCreate,
	awaitRegister,
	dropSessionResume,
	onSessionEnded,
	sessionStore,
}: SessionLifecycleDeps) {
	async function createSession(
		op: Extract<ConsoleOp, { kind: "create_session" }>,
		conversationId: string,
		opId: string,
	) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		if (!op.sessionName && !op.displayLabel) {
			throw new Error("create_session needs a sessionName or a displayLabel");
		}
		const spawn = targets.localSpawn(op.target);
		if (op.workdir != null && !isSpawnWorkdirPath(spawn, op.workdir)) {
			throw new Error("invalid workdir: must be an absolute, ~-rooted, or Windows drive path");
		}
		const labelSanitized = op.displayLabel != null && sanitizeLabel(op.displayLabel) === null;
		const dedupKey = `${conversationId}:${opId}`;
		let sessionId: string;
		let label: string;
		let adopted: { record: SessionRecord; created: boolean } | null | undefined;
		if (op.sessionName) {
			sessionId = op.sessionName;
			label = op.displayLabel ?? sessionId;
			adopted = sessionStore?.adoptOrReattach(sessionId, {
				spawn,
				sessionLabel: label,
				workdirHint: label,
				workdirPath: op.workdir,
				mintedFrom: dedupKey,
			});
		} else {
			label = op.displayLabel as string;
			const minted = sessionStore?.mintOrReattach({
				spawn,
				sessionLabel: label,
				workdirHint: label,
				workdirPath: op.workdir,
				mintedFrom: dedupKey,
			});
			sessionId = minted?.record.id ?? label;
			adopted = minted ?? null;
		}
		if (sessionStore && !adopted) {
			throw new Error(`cannot create session "${sessionId}": the name is reserved or a project`);
		}
		// The console is the authority: the record outlives a launch that fails, listed asleep until a forget.
		const target = targets.tmuxTarget(op.target, sessionId);
		const workdirHint =
			sessionStore && adopted ? sessionStore.hostWorkdirHint(adopted.record) : (op.workdir ?? label);

		const launchTeam = composeSessionName(target.name, target.sessionName);
		const viaWake = target.kind === "devcontainer" && tryWakeTeam;
		const startLaunch = (): Promise<HostOpResult> =>
			viaWake
				? viaWake(launchTeam).then(
						(r): HostOpResult =>
							r.ok
								? { ok: true }
								: {
										ok: false,
										error: `failed to wake "${sessionId}"`,
										errorKind: r.errorKind,
									},
					)
				: relayToHost({
						kind: "createSession",
						target,
						workdirHint,
						resumeSessionId: adopted?.record.claudeSessionId,
						sessionToken: adopted ? sessionStore?.ensureBindToken(adopted.record) : undefined,
						dedupKey,
					});

		const shared = joinCreate?.(launchTeam, startLaunch);
		const launch = shared?.launch ?? startLaunch();
		const release = shared?.release;
		// Presence outlives the launch, since a created session is not usable until it registers.
		if (release) {
			fireAndForget(
				`create release for ${launchTeam}`,
				(async () => {
					// A launch that failed has nothing to register, and waiting would hold the team.
					const settled = await launch.catch(() => null);
					if (settled?.ok && !viaWake && awaitRegister) {
						await awaitRegister(launchTeam).catch(() => undefined);
					}
					release();
				})(),
			);
		}

		const winner = await withinMs(ambient, launch, createSessionBoundMs);

		if (winner === null) {
			launch.catch(() => undefined);
			return {
				created: true,
				id: adopted?.record.id ?? sessionId,
				sessionLabel: adopted?.record.sessionLabel,
				labelSanitized,
				status: "pending" as const,
			};
		}

		if (!winner.ok) {
			if (winner.errorKind === "timeout" || winner.errorKind === "disconnected") {
				throw new CreateSessionAmbiguousError(winner.error ?? "create session had no definitive answer");
			}
			throw new Error(winner.error ?? "create session failed");
		}
		return {
			created: true,
			id: adopted?.record.id ?? sessionId,
			sessionLabel: adopted?.record.sessionLabel,
			labelSanitized,
		};
	}

	async function wake(op: Extract<ConsoleOp, { kind: "wake" }>) {
		if (!tryWakeTeam) throw new Error("wake is unavailable");
		const { name, spawn, session } = targets.requireLocalComposite(op.target, "wake");
		const adopted =
			sessionStore && !sessionStore.getByTeam(name)
				? sessionStore.adoptById(session, { spawn, sessionLabel: session, workdirHint: session })
				: null;
		const mayForget = () => {
			if (!adopted || !sessionStore) return false;
			const current = sessionStore.getByTeam(name);
			return current === adopted && current.confirmedAt === undefined;
		};
		const wakeCall = tryWakeTeam(name);
		const winner = await withinMs(ambient, wakeCall, createSessionBoundMs);
		if (winner === null) {
			void wakeCall
				.then((r) => {
					if (!r.ok && mayForget()) sessionStore?.forget(name);
				})
				.catch(() => {
					if (mayForget()) sessionStore?.forget(name);
				});
			return { ok: true, status: "pending" as const };
		}
		if (!winner.ok) {
			if (mayForget()) sessionStore?.forget(name);
			const reason =
				winner.error ??
				(winner.errorKind === "disconnected"
					? "the host is not connected"
					: winner.errorKind === "timeout"
						? "it did not come online in time"
						: "unknown error");
			throw new Error(`failed to wake "${name}": ${reason}`);
		}
		return winner;
	}

	async function closeSession(
		op: Extract<ConsoleOp, { kind: "close_session" }>,
		conversationId: string,
		opId: string,
	) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		const { name } = targets.requireLocalComposite(op.target, "close");
		const target = targets.tmuxTarget(op.target);
		const record = sessionStore?.getByTeam(name);
		if (!ownTerminal(record, (r) => sessionStore!.teamOf(r))) {
			throw new Error(`"${name}" is user-launched; end it from your terminal`);
		}
		if (isWakeInFlight?.(name)) {
			throw new Error(`"${name}" is waking; wait for it to finish before closing`);
		}
		const dedupKey = `${conversationId}:${opId}`;
		const r = await relayToHost({ kind: "killSession", target, dedupKey });
		if (!r.ok) throw new Error(r.error ?? "close failed");
		onSessionEnded?.(name);
		return { closed: true };
	}

	async function forget(op: Extract<ConsoleOp, { kind: "forget" }>, conversationId: string, opId: string) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		const { name } = targets.requireLocalComposite(op.target, "forget");
		if (isWakeInFlight?.(name)) throw new Error(`"${name}" is waking; wait for it to finish before forgetting`);
		// Close refuses a terminal it did not launch; forget drops the record and leaves it running.
		const record = sessionStore?.getByTeam(name);
		let killed = false;
		if (ownTerminal(record, (r) => sessionStore!.teamOf(r))) {
			const dedupKey = `${conversationId}:${opId}`;
			try {
				const target = targets.tmuxTarget(op.target);
				const r = await relayToHost({ kind: "killSession", target, dedupKey });
				killed = r.ok;
				if (!r.ok) console.log(`[console] forget "${name}": kill failed - ${r.error ?? "unknown error"}`);
			} catch (e) {
				console.log(`[console] forget "${name}": kill failed - ${(e as Error).message}`);
			}
		}
		const disposition: BoardDisposition = op.boardDisposition ?? "release";
		dropSessionResume?.(name, disposition);
		onSessionEnded?.(name);
		// The record always goes; the kill is a courtesy that can honestly fail.
		return { killed, boardDisposition: disposition };
	}

	function renameSession(op: Extract<ConsoleOp, { kind: "rename_session" }>) {
		const { name } = targets.requireLocalComposite(op.target, "rename");
		const applied = sessionStore?.rename(name, op.sessionLabel) ?? null;
		return { renamed: applied !== null, sessionLabel: applied ?? undefined };
	}

	return { createSession, wake, closeSession, forget, renameSession };
}
