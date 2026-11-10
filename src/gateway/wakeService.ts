import type { ServerWebSocket } from "bun";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { cliRefusalText, pickAt } from "../shared/cli-resolve.js";
import { type HostOpResult, isReservedHostSession } from "../shared/host-op.js";
import { isHostSpawn, launchPlaceOf } from "../shared/host-spawn.js";
import { type SessionHarness, UNPICKED_WORD } from "../shared/session-harness.js";
import { isComposite, parseSessionName } from "../shared/session-id.js";
import { resumeIdOf, type SessionStore } from "../shared/session-store.js";
import type { PresenceFacade } from "./presence.js";
import { decideWakeCreate, type WakeCoordinator, type WakeCreate, type WakeResult } from "./wake.js";
import { reached, sendOn } from "./wsSend.js";
import { resolveLiveIncarnation, type TeamRegistry, type WsData } from "./wsTypes.js";

export interface WakeServiceDeps {
	registry: TeamRegistry;
	sessionStore: SessionStore;
	presence: Pick<PresenceFacade, "wakeStart" | "wakeEnd" | "createStart" | "createEnd" | "mintOrReattach" | "forget">;
	wakeCoordinator: WakeCoordinator;
	isAvailableProject: (name: string) => boolean;
	knownTeamPaths: Map<string, string>;
	offlineCatalog: Map<string, string>;
	liveHostSocket: () => ServerWebSocket<WsData> | undefined;
	wakeTimeoutMs: number;
	/** Undefined until known. */
	installedAt?: (spawn: string) => readonly SessionHarness[] | undefined;
}

/** The team at launch, then the outcome. */
export interface WakeFlight {
	started: Promise<WakeStart>;
	outcome: Promise<WakeResult>;
}

export type WakeStart = { kind: "launching"; team: string; created: boolean } | { kind: "settled"; result: WakeResult };

export class WakeService {
	// One launch per team.
	private flights = new Map<string, WakeFlight>();
	/** Minted names a flight launches under. */
	private launching = new Set<string>();
	private inflightCreates = new Map<string, Promise<HostOpResult>>();
	private settledListeners: Array<(team: string, result: WakeResult) => void> = [];

	constructor(private deps: WakeServiceDeps) {}

	isWakeInFlight(team: string): boolean {
		return this.flights.has(team) || this.launching.has(team) || this.inflightCreates.has(team);
	}

	/** The first caller launches and is handed the release; the rest join it and get none. */
	joinCreate(
		team: string,
		start: () => Promise<HostOpResult>,
	): { launch: Promise<HostOpResult>; release: (() => void) | null } {
		const existing = this.inflightCreates.get(team);
		if (existing) {
			console.log(`[create] ${team} create already in flight; joining it`);
			return { launch: existing, release: null };
		}
		const launch = start();
		this.inflightCreates.set(team, launch);
		this.deps.presence.createStart(team);
		return {
			launch,
			release: () => {
				if (this.inflightCreates.delete(team)) this.deps.presence.createEnd(team);
			},
		};
	}

	/** Every launch's end, whoever started it. */
	onSettled(listener: (team: string, result: WakeResult) => void): void {
		this.settledListeners.push(listener);
	}

	tryWakeTeam(team: string, createOpts?: WakeCreate): Promise<WakeResult> {
		return this.beginWake(team, createOpts).outcome;
	}

	/** Joins a launch in flight for the team, or starts one. */
	beginWake(team: string, createOpts?: WakeCreate): WakeFlight {
		const held = this.flights.get(team);
		if (held) {
			console.log(`[wake] ${team} wake already in flight; joining it`);
			return held;
		}
		let announce: (start: WakeStart) => void = () => {};
		const started = new Promise<WakeStart>((resolve) => {
			announce = resolve;
		});
		let flight: WakeFlight | undefined;
		// Create launches under its minted name.
		let minted: string | undefined;
		const outcome = (async () => {
			this.deps.presence.wakeStart(team);
			try {
				const result = await this.doWakeTeam(team, createOpts, (wakeTeam, created) => {
					if (wakeTeam !== team) {
						minted = wakeTeam;
						this.deps.presence.wakeStart(wakeTeam);
						if (flight) this.flights.set(wakeTeam, flight);
					}
					announce({ kind: "launching", team: wakeTeam, created });
				});
				announce({ kind: "settled", result });
				return result;
			} catch (error) {
				announce({
					kind: "settled",
					result: { ok: false, error: error instanceof Error ? error.message : String(error) },
				});
				throw error;
			} finally {
				this.deps.presence.wakeEnd(team);
				if (minted) this.deps.presence.wakeEnd(minted);
				for (const name of [team, minted]) {
					if (name && this.flights.get(name) === flight) this.flights.delete(name);
				}
			}
		})();
		flight = { started, outcome };
		this.flights.set(team, flight);
		if (minted) this.flights.set(minted, flight);
		return flight;
	}

	/** A create's CLI where its place's are known; absent waits on the place. */
	private pickFor(team: string, named: SessionHarness | undefined) {
		const { project } = parseSessionName(team);
		const at = { place: launchPlaceOf(project), assistant: team === ASSISTANT_TEAM };
		return pickAt(at, named, this.deps.installedAt?.(project));
	}

	private async doWakeTeam(
		team: string,
		createOpts: WakeCreate | undefined,
		onStarted: (wakeTeam: string, created: boolean) => void,
	): Promise<WakeResult> {
		const { project, session } = parseSessionName(team);
		if (this.deps.isAvailableProject(project) && (!isComposite(team) || !this.deps.offlineCatalog.has(project))) {
			console.log(`[wake] ${team} is a spawn-point project, not a session; not waking`);
			return { ok: false };
		}

		if (resolveLiveIncarnation(this.deps.registry, this.deps.sessionStore, team)) {
			console.log(`[wake] ${team} already has a live incarnation; not waking`);
			return { ok: true };
		}

		if (isHostSpawn(project) && isReservedHostSession(session)) {
			console.log(`[wake] ${team} is a reserved host session; not waking`);
			return { ok: false };
		}
		let pendingMint: { sessionLabel: string; create: WakeCreate } | undefined;
		if (isComposite(team)) {
			const decision = decideWakeCreate(
				team,
				this.deps.sessionStore.getByTeam(team) != null,
				createOpts?.displayLabel,
			);
			if (decision.kind === "refuse") {
				console.log(`[wake] ${team} has no record and no displayLabel; refusing to adopt the typed name`);
				return { ok: false, error: decision.error, refusal: decision.refusal };
			}
			if (decision.kind === "mint" && isHostSpawn(project) && !createOpts?.cleared) {
				// Only create_session, or a cleared assistant send, mints a host session.
				console.log(`[wake] refusing to mint host session "${team}" - create_session owns that door`);
				return { ok: false, error: `no session named "${team}"; create it from the console first` };
			}
			// A label arrives only with create options.
			if (decision.kind === "mint" && createOpts) {
				const pick = this.pickFor(team, createOpts.harness);
				if ("refused" in pick)
					return {
						ok: false,
						error: cliRefusalText(pick.refused, team),
						refusal: { kind: "cli", refusal: pick.refused },
					};
				pendingMint = { sessionLabel: decision.sessionLabel, create: { ...createOpts, harness: pick.harness } };
			}
		}

		const hostWs = this.deps.liveHostSocket();

		if (!hostWs) {
			console.log(`[wake] cannot wake ${team} - host is not connected`);
			return { ok: false, errorKind: "disconnected" };
		}

		let provisionalCreated = false;
		let wakeTeam = team;
		if (pendingMint) {
			const minted = this.deps.presence.mintOrReattach({
				spawn: project,
				sessionLabel: pendingMint.sessionLabel,
				workdirHint: pendingMint.sessionLabel,
				harness: pendingMint.create.harness,
				mintedFrom: pendingMint.create.mintedFrom,
			});
			provisionalCreated = minted.created;
			wakeTeam = this.deps.sessionStore.teamOf(minted.record);
			// A resend reattached to a session already up.
			if (resolveLiveIncarnation(this.deps.registry, this.deps.sessionStore, wakeTeam)) {
				return { ok: true, resolvedTeam: wakeTeam };
			}
		}

		// One launch per pane: a create's goes first.
		const creating = this.inflightCreates.get(wakeTeam);
		if (creating) {
			await creating.catch(() => undefined);
			if (resolveLiveIncarnation(this.deps.registry, this.deps.sessionStore, wakeTeam)) {
				return wakeTeam !== team ? { ok: true, resolvedTeam: wakeTeam } : { ok: true };
			}
		}
		const liveHost = creating ? this.deps.liveHostSocket() : hostWs;
		if (!liveHost) return { ok: false, errorKind: "disconnected" };

		const projectPath = this.deps.offlineCatalog.get(project) ?? this.deps.knownTeamPaths.get(project);
		const record = this.deps.sessionStore.getByTeam(wakeTeam);
		const resumeSessionId = record ? resumeIdOf(record) : undefined;
		const workdirHint = record ? this.deps.sessionStore.hostWorkdirHint(record) : undefined;
		const requested = sendOn(
			liveHost,
			JSON.stringify({
				type: "wake",
				team: wakeTeam,
				...(projectPath ? { projectPath } : {}),
				// A team with no record runs its place's only CLI.
				harness: record?.harness ?? UNPICKED_WORD,
				...(resumeSessionId ? { resumeSessionId } : {}),
				...(record && record.confirmedAt === undefined ? { fresh: true } : {}),
				...(workdirHint ? { workdirHint } : {}),
				...(record ? { sessionToken: this.deps.sessionStore.ensureBindToken(record) } : {}),
			}),
			`wake ${wakeTeam}`,
		);
		// Dropped wakes never answer.
		if (!reached(requested)) return { ok: false, errorKind: "disconnected" };
		onStarted(wakeTeam, provisionalCreated);

		console.log(
			`[wake] requesting ${wakeTeam} startup${projectPath ? ` (${projectPath})` : " (convention)"}${
				resumeSessionId ? `, resuming ${resumeSessionId}` : ", no transcript to resume"
			}`,
		);

		this.launching.add(wakeTeam);
		const result = await this.deps.wakeCoordinator
			.waitFor(wakeTeam, this.deps.wakeTimeoutMs)
			.finally(() => this.launching.delete(wakeTeam));
		// Only a create's record goes.
		if (result.errorKind === "timeout" && provisionalCreated) {
			const live = this.deps.liveHostSocket();
			if (live) sendOn(live, JSON.stringify({ type: "wake_cancel", team: wakeTeam }), `wake_cancel ${wakeTeam}`);
		}
		console.log(`[wake] ${wakeTeam} ${result.ok ? "is now online" : "failed to come online"}`);
		for (const listener of this.settledListeners) listener(wakeTeam, result);
		// Launch record decides, not the host link.
		if (!result.ok && provisionalCreated && result.errorKind !== "disconnected") {
			const rec = this.deps.sessionStore.getByTeam(wakeTeam);
			if (
				rec &&
				rec.confirmedAt === undefined &&
				!resolveLiveIncarnation(this.deps.registry, this.deps.sessionStore, wakeTeam)
			) {
				this.deps.presence.forget(wakeTeam);
			}
		}
		return wakeTeam !== team ? { ...result, resolvedTeam: wakeTeam } : result;
	}
}
