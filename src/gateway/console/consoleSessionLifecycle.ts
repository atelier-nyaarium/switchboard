import { type Ambient, withinMs } from "../../shared/ambient.js";
import type { BoardDisposition } from "../../shared/board-authority.js";
import type { ConsoleOp } from "../../shared/console-protocol.js";
import { type HostOp, type HostOpResult, isSpawnWorkdirPath } from "../../shared/host-op.js";
import { launchPlaceOf } from "../../shared/host-spawn.js";
import { launchFailureText } from "../../shared/launch-notice.js";
import {
	foldHarness,
	launchRefusal,
	olderThanSender,
	readHarness,
	type SessionHarness,
	UNNAMED_HARNESS,
	UNPICKED_WORD,
} from "../../shared/session-harness.js";
import { composeSessionName } from "../../shared/session-id.js";
import { sanitizeLabel } from "../../shared/session-sanitize.js";
import { resumeIdOf, type SessionRecord, type SessionStore } from "../../shared/session-store.js";
import { fireAndForget } from "../fireAndForget.js";
import type { WakeResult } from "../wake.js";
import type { ConsoleTargets } from "./consoleTargets.js";
import { CreateSessionAmbiguousError, CreateSessionFailedError } from "./consoleTypes.js";

/** Whether this Gateway launched the record's terminal; hand-started ones run under another name. */
export function ownTerminal(record: SessionRecord | undefined, teamOf: (record: SessionRecord) => string): boolean {
	return !record?.liveTeam || record.liveTeam.team === teamOf(record);
}

export interface SessionLifecycleDeps {
	targets: ConsoleTargets;
	createSessionBoundMs: number;
	ambient: Pick<Ambient, "setTimer" | "clearTimer" | "newId">;
	relayToHost?: (op: HostOp) => Promise<HostOpResult>;
	/** `retain`: a joined launch is never given up. */
	tryWakeTeam?: (team: string, opts?: { retain?: true }) => Promise<WakeResult>;
	isWakeInFlight?: (team: string) => boolean;
	joinCreate?: (
		team: string,
		start: () => Promise<HostOpResult>,
	) => { launch: Promise<HostOpResult>; release: (() => void) | null };
	awaitRegister?: (team: string) => Promise<WakeResult>;
	dropSessionResume?: (team: string, boardDisposition: BoardDisposition) => void;
	/** Close and forget end session grants. */
	onSessionEnded?: (team: string) => void;
	forgetRefusal?: (team: string) => string | null;
	sessionStore?: Pick<
		SessionStore,
		| "getByTeam"
		| "teamOf"
		| "adoptById"
		| "adoptOrReattach"
		| "mintOrReattach"
		| "paneHolder"
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
	forgetRefusal,
	sessionStore,
}: SessionLifecycleDeps) {
	async function createSession(
		op: Extract<ConsoleOp, { kind: "create_session" }>,
		conversationId: string,
		opId: string,
		/** Place's CLIs not known yet. */
		internal?: { unpicked: true },
	) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		if (!op.sessionName && !op.displayLabel) {
			throw new Error("create_session needs a sessionName or a displayLabel");
		}
		const spawn = targets.localSpawn(op.target);
		const harness: SessionHarness | undefined = internal?.unpicked
			? undefined
			: foldHarness(readHarness(op.harness), {
					named: (named) => named,
					unnamed: (assumed) => assumed,
					unpicked: () => {
						throw new Error("a console create names its CLI");
					},
					unknown: (word) => {
						throw new Error(olderThanSender(word));
					},
				});
		const refusal = harness && launchRefusal(harness, { place: launchPlaceOf(spawn), assistant: false });
		if (refusal) throw new Error(refusal);
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
				harness,
				mintedFrom: dedupKey,
			});
		} else {
			label = op.displayLabel as string;
			const minted = sessionStore?.mintOrReattach({
				spawn,
				sessionLabel: label,
				workdirHint: label,
				workdirPath: op.workdir,
				harness,
				mintedFrom: dedupKey,
			});
			sessionId = minted?.record.id ?? label;
			adopted = minted ?? null;
		}
		if (sessionStore && !adopted) {
			throw new Error(`cannot create session "${sessionId}": the name is reserved or a project`);
		}
		// The record outlives a failed launch.
		const target = targets.tmuxTarget(op.target, sessionId);
		const workdirHint =
			sessionStore && adopted ? sessionStore.hostWorkdirHint(adopted.record) : (op.workdir ?? label);

		const launchTeam = composeSessionName(target.name, target.sessionName);
		const viaWake = target.kind === "devcontainer" && tryWakeTeam;
		const startLaunch = (): Promise<HostOpResult> =>
			viaWake
				? viaWake(launchTeam, { retain: true }).then(
						(r): HostOpResult =>
							r.ok
								? { ok: true }
								: {
										ok: false,
										error: `failed to wake "${sessionId}"`,
										errorKind: r.errorKind,
										...(r.failure ? { failure: r.failure } : {}),
									},
					)
				: relayToHost({
						kind: "createSession",
						target,
						workdirHint,
						harness: adopted?.record.harness ?? harness ?? UNPICKED_WORD,
						resumeSessionId: adopted ? resumeIdOf(adopted.record) : undefined,
						...(adopted && adopted.record.confirmedAt === undefined ? { fresh: true as const } : {}),
						sessionToken: adopted ? sessionStore?.ensureBindToken(adopted.record) : undefined,
						dedupKey,
						launchId: ambient.newId(),
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

		// No blank record survives an unpicked create.
		const forgetBlank = (): void => {
			if (!internal?.unpicked || !adopted?.created) return;
			const current = sessionStore?.getByTeam(launchTeam);
			if (current && current.confirmedAt === undefined && !current.harness) sessionStore?.forget(launchTeam);
		};
		const winner = await withinMs(ambient, launch, createSessionBoundMs);

		if (winner === null) {
			launch.then((late) => late.failure && forgetBlank()).catch(() => undefined);
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
			if (winner.failure) {
				forgetBlank();
				throw new CreateSessionFailedError(
					launchFailureText(winner.failure, sessionId, { created: true, foreign: false }),
					winner.failure,
				);
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
		const holder = sessionStore?.paneHolder(name);
		if (holder) throw new Error(`"${name}" shares its pane with "${holder.team}"; wake that one instead`);
		const adopted =
			sessionStore && !sessionStore.getByTeam(name)
				? sessionStore.adoptById(session, {
						spawn,
						sessionLabel: session,
						workdirHint: session,
						// FIXME 2026-11-24: drop the fallback, once every phone names the row's CLI.
						harness: op.harness ?? UNNAMED_HARNESS,
					})
				: null;
		const mayForget = () => {
			if (!adopted || !sessionStore) return false;
			const current = sessionStore.getByTeam(name);
			return current === adopted && current.confirmedAt === undefined;
		};
		const wakeCall = tryWakeTeam(name, { retain: true });
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

	/** `released` is a release op already admitting the reserved session. */
	async function forget(
		op: Extract<ConsoleOp, { kind: "forget" }>,
		conversationId: string,
		opId: string,
		{ released = false }: { released?: boolean } = {},
	) {
		if (!relayToHost) throw new Error("terminal view unavailable on this Gateway");
		const { name } = targets.requireLocalComposite(op.target, "forget");
		const refusal = released ? null : forgetRefusal?.(name);
		if (refusal) throw new Error(`cannot forget "${name}": ${refusal}`);
		if (isWakeInFlight?.(name)) throw new Error(`"${name}" is waking; wait for it to finish before forgetting`);
		// Forget leaves a foreign terminal running.
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
		// The kill may fail; the record goes regardless.
		return { killed, boardDisposition: disposition };
	}

	function renameSession(op: Extract<ConsoleOp, { kind: "rename_session" }>) {
		const { name } = targets.requireLocalComposite(op.target, "rename");
		const applied = sessionStore?.rename(name, op.sessionLabel) ?? null;
		return { renamed: applied !== null, sessionLabel: applied ?? undefined };
	}

	return { createSession, wake, closeSession, forget, renameSession };
}
