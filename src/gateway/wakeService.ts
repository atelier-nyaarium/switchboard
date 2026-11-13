import type { ServerWebSocket } from "bun";
import { ASSISTANT_TEAM } from "../shared/assistant-session.js";
import { cliRefusalText, pickAt } from "../shared/cli-resolve.js";
import { isReservedHostSession } from "../shared/host-op.js";
import { isHostSpawn, launchPlaceOf } from "../shared/host-spawn.js";
import { type SessionHarness, UNPICKED_WORD } from "../shared/session-harness.js";
import { isComposite, parseSessionName } from "../shared/session-id.js";
import { resumeIdOf, type SessionStore } from "../shared/session-store.js";
import type { PresenceFacade } from "./presence.js";
import { decideWakeCreate, type WakeCoordinator, type WakeCreate, type WakeResult } from "./wake.js";
import { reached, sendOn } from "./wsSend.js";
import { REGISTER_WINDOW_MS, resolveLiveIncarnation, type TeamRegistry, type WsData } from "./wsTypes.js";

export interface WakeServiceDeps {
	registry: TeamRegistry;
	sessionStore: SessionStore;
	presence: Pick<PresenceFacade, "wakeStart" | "wakeEnd" | "mintOrReattach" | "forget">;
	wakeCoordinator: WakeCoordinator;
	isAvailableProject: (name: string) => boolean;
	knownTeamPaths: Map<string, string>;
	offlineCatalog: Map<string, string>;
	liveHostSocket: () => ServerWebSocket<WsData> | undefined;
	wakeTimeoutMs: number;
	/** Undefined until known. */
	installedAt?: (spawn: string) => readonly SessionHarness[] | undefined;
	newLaunchId: () => string;
}

/** Where a launch is held durably; the one give-up authority. */
export interface LaunchLedger {
	/** False when it could not be written; nothing is dispatched. */
	open(team: string, launchId: string, created: boolean, retained: boolean): boolean;
	/** The owner asked for it: never given up or forgotten. */
	retain(launchId: string): boolean;
	/** Never dispatched; nothing to settle. */
	abandon(launchId: string): void;
}

/** The team at launch, then the outcome. */
export interface WakeFlight {
	started: Promise<WakeStart>;
	outcome: Promise<WakeResult>;
}

export type WakeStart =
	| { kind: "launching"; team: string; created: boolean; launchId: string }
	| { kind: "settled"; result: WakeResult };

/** `retain`: owner asked. `door`: create leaves found panes. */
export interface LaunchOpts {
	retain?: true;
	door?: "create";
}

/** A flight's dispatched launch and owner claim. */
interface FlightClaim {
	launchId?: string;
	retained: boolean;
}

export class WakeService {
	// One launch per team.
	private flights = new Map<string, WakeFlight>();
	/** Per-team wake holds. */
	private holds = new Map<string, Promise<void>>();
	private claims = new WeakMap<WakeFlight, FlightClaim>();
	private ledger: LaunchLedger | null = null;
	private settledListeners: Array<(team: string, result: WakeResult, launchId?: string) => void> = [];

	constructor(private deps: WakeServiceDeps) {}

	/** Held until registered and answered; Close and Forget wait. */
	isWakeInFlight(team: string): boolean {
		return this.flights.has(team);
	}

	/** Launches wait for the release. */
	hold(team: string): () => void {
		let open: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			open = resolve;
		});
		this.holds.set(team, held);
		return () => {
			if (this.holds.get(team) === held) this.holds.delete(team);
			open();
		};
	}

	/** Every launch's end, whoever started it. */
	onSettled(listener: (team: string, result: WakeResult, launchId?: string) => void): void {
		this.settledListeners.push(listener);
	}

	/** Bound after the ledger is built. */
	useLedger(ledger: LaunchLedger): void {
		this.ledger = ledger;
	}

	tryWakeTeam(team: string, createOpts?: WakeCreate, opts?: LaunchOpts): Promise<WakeResult> {
		return this.beginWake(team, createOpts, opts).outcome;
	}

	/** Joins the team's launch, or starts one. */
	beginWake(team: string, createOpts?: WakeCreate, opts?: LaunchOpts): WakeFlight {
		const held = this.flights.get(team);
		if (held) {
			console.log(`[wake] ${team} wake already in flight; joining it`);
			if (opts?.retain) this.retain(held);
			return held;
		}
		let announce: (start: WakeStart) => void = () => {};
		const started = new Promise<WakeStart>((resolve) => {
			announce = resolve;
		});
		let flight: WakeFlight | undefined;
		const claim: FlightClaim = { retained: opts?.retain === true };
		// Create launches under its minted name.
		let minted: string | undefined;
		const outcome = (async () => {
			this.deps.presence.wakeStart(team);
			try {
				const held = this.holds.get(team);
				if (held) await held;
				const result = await this.doWakeTeam(
					team,
					createOpts,
					claim,
					opts?.door,
					(wakeTeam, created, launchId) => {
						if (wakeTeam !== team) {
							minted = wakeTeam;
							this.deps.presence.wakeStart(wakeTeam);
							if (flight) this.flights.set(wakeTeam, flight);
						}
						announce({ kind: "launching", team: wakeTeam, created, launchId });
					},
				);
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
		this.claims.set(flight, claim);
		this.flights.set(team, flight);
		if (minted) this.flights.set(minted, flight);
		return flight;
	}

	/** Durable before it counts. */
	private retain(flight: WakeFlight): void {
		const claim = this.claims.get(flight);
		if (!claim || claim.retained) return;
		if (claim.launchId && this.ledger && !this.ledger.retain(claim.launchId)) {
			console.warn(`[wake] could not record the owner's claim on launch ${claim.launchId}`);
			return;
		}
		claim.retained = true;
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
		claim: FlightClaim,
		door: "create" | undefined,
		onStarted: (wakeTeam: string, created: boolean, launchId: string) => void,
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

		const launchId = this.deps.newLaunchId();
		if (this.ledger && !this.ledger.open(wakeTeam, launchId, provisionalCreated, claim.retained)) {
			// Nothing launched; release record.
			if (provisionalCreated) this.deps.presence.forget(wakeTeam);
			return { ok: false, error: `the launch of "${wakeTeam}" could not be recorded` };
		}
		claim.launchId = launchId;

		const projectPath = this.deps.offlineCatalog.get(project) ?? this.deps.knownTeamPaths.get(project);
		const record = this.deps.sessionStore.getByTeam(wakeTeam);
		const resumeSessionId = record ? resumeIdOf(record) : undefined;
		const workdirHint = record ? this.deps.sessionStore.hostWorkdirHint(record) : undefined;
		const requested = sendOn(
			hostWs,
			JSON.stringify({
				type: "wake",
				team: wakeTeam,
				launchId,
				...(door ? { door } : {}),
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
		if (!reached(requested)) {
			this.ledger?.abandon(launchId);
			return { ok: false, errorKind: "disconnected" };
		}
		onStarted(wakeTeam, provisionalCreated, launchId);

		console.log(
			`[wake] requesting ${wakeTeam} startup${projectPath ? ` (${projectPath})` : " (convention)"}${
				resumeSessionId ? `, resuming ${resumeSessionId}` : ", no transcript to resume"
			}`,
		);

		const result = await this.deps.wakeCoordinator.waitFor(wakeTeam, this.deps.wakeTimeoutMs, launchId);
		// Daemon may still launch after registration.
		// An untagged daemon's answer names no launch.
		if (result.ok && hostWs.data.launchIds)
			await this.deps.wakeCoordinator.daemonDone(launchId, REGISTER_WINDOW_MS);
		console.log(`[wake] ${wakeTeam} ${result.ok ? "is now online" : "failed to come online"}`);
		// The ledger settles it.
		for (const listener of this.settledListeners) listener(wakeTeam, result, launchId);
		return wakeTeam !== team ? { ...result, resolvedTeam: wakeTeam } : result;
	}
}
