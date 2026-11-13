// The host daemon socket and everything routed over it.

import type { ServerWebSocket } from "bun";
import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { type HostSpawnState, hostSpawnPoint } from "../../shared/host-spawn.js";
import { SESSION_HARNESSES, type SessionHarness } from "../../shared/session-harness.js";
import type { HostLivenessReader } from "../hostLiveness.js";
import { HostOpCoordinator } from "../hostOpCoordinator.js";
import { WakeCoordinator } from "../wake.js";
import { WakeService } from "../wakeService.js";
import { reached, sendOn } from "../wsSend.js";
import { resolveLiveIncarnation, type WsData } from "../wsTypes.js";
import type { SessionsStage } from "./composeSessions.js";

const HOST_OP_TIMEOUT_MS = 20_000;
/** Listing may launch CLI. */
const SLOW_HOST_OP_MS: Partial<Record<HostOp["kind"], number>> = {
	typeIntoPane: 240_000,
	agentModels: 90_000,
	// Outlast CLI startup and request.
	purge: 150_000,
	// A store of thousands pages for a while.
	threads: 150_000,
};
export const PRESENCE_PEEK_MS = 2_000;
const WATCH_PUSH_MS = 2_000;

export interface HostStageDeps {
	sessions: Pick<
		SessionsStage,
		| "registry"
		| "sessionStore"
		| "presence"
		| "isAvailableProject"
		| "knownTeamPaths"
		| "offlineCatalog"
		| "hostSpawnPoints"
	>;
	wakeTimeoutMs: number;
	ambient: Ambient;
}

export interface HostStage {
	liveHostSocket: () => ServerWebSocket<WsData> | undefined;
	readLiveness: HostLivenessReader;
	wakeCoordinator: WakeCoordinator;
	hostOpCoordinator: HostOpCoordinator;
	wakeService: WakeService;
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
	/** Re-sends the watch list; `force` re-sends an unchanged one. */
	pushPresenceWatch: (force?: boolean) => void;
	presenceWatchTimer: IntervalHandle;
	/** What a spawn point runs; undefined until the daemon said. */
	installedAt: (spawn: string) => readonly SessionHarness[] | undefined;
}

/** What a spawn point runs, as the daemon last said; undefined until it has. */
function installedAt(state: HostSpawnState, spawn: string): readonly SessionHarness[] | undefined {
	if (!state.known) return undefined;
	if (hostSpawnPoint(spawn))
		return SESSION_HARNESSES.filter((harness) => state.harnessSpawns?.[harness]?.includes(spawn));
	const container = state.containers?.find((held) => held.project === spawn);
	// Checked again at launch: not running, or none seen yet.
	return container?.state === "running" && container.clis?.length ? container.clis : undefined;
}

export function composeHost({ sessions, wakeTimeoutMs, ambient }: HostStageDeps): HostStage {
	const wakeCoordinator = new WakeCoordinator(ambient, (team) =>
		Boolean(resolveLiveIncarnation(sessions.registry, sessions.sessionStore, team)),
	);
	const hostOpCoordinator = new HostOpCoordinator(ambient);

	function liveHostSocket(): ServerWebSocket<WsData> | undefined {
		const hostSubs = sessions.registry.get("host");
		return hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;
	}

	const readLiveness: HostLivenessReader = () => {
		const socket = liveHostSocket();
		const catalogProjects = socket?.data.catalogProjects;
		return {
			socket,
			daemonInstanceId: socket?.data.daemonInstanceId,
			containerInCatalog: (target) =>
				target.kind === "devcontainer" && (catalogProjects?.has(target.project) ?? false),
		};
	};

	const wakeService = new WakeService({
		registry: sessions.registry,
		sessionStore: sessions.sessionStore,
		presence: sessions.presence,
		wakeCoordinator,
		isAvailableProject: sessions.isAvailableProject,
		knownTeamPaths: sessions.knownTeamPaths,
		offlineCatalog: sessions.offlineCatalog,
		liveHostSocket,
		wakeTimeoutMs,
		installedAt: (spawn) => installedAt(sessions.hostSpawnPoints, spawn),
		newLaunchId: () => ambient.newId(),
	});

	async function relayToHost(op: HostOp): Promise<HostOpResult> {
		const hostWs = liveHostSocket();
		if (!hostWs) return { ok: false, error: "host daemon offline - terminal unavailable" };
		const reqId = ambient.randomBytes(8).toString("hex");
		// Dropped requests never answer.
		if (!reached(sendOn(hostWs, JSON.stringify({ type: "host_op", reqId, op }), `host_op ${op.kind}`)))
			return { ok: false, error: "the host daemon did not take the request" };
		return hostOpCoordinator.wait(reqId, SLOW_HOST_OP_MS[op.kind] ?? HOST_OP_TIMEOUT_MS);
	}

	let lastPushedWatch = "";
	function pushPresenceWatch(force = false): void {
		const hostWs = liveHostSocket();
		if (!hostWs) return;
		const liveTeams = sessions.presence
			.snapshot()
			.filter((row) => row.status === "online" || row.status === "verifying")
			.map((row) => row.team);
		// A live row always has a record.
		const watch = liveTeams.flatMap((team) => {
			const record = sessions.sessionStore.getByTeam(team);
			if (!record) return [];
			const sessionId = record.mintedSessionId;
			return [
				{
					team,
					cadenceMs: PRESENCE_PEEK_MS,
					harness: record.harness,
					...(sessionId ? { mintedSessionId: sessionId } : {}),
					// FIXME 2026-11-23: drop, once every daemon reads `mintedSessionId`.
					...(sessionId && record.harness === "copilot" ? { copilotSessionId: sessionId } : {}),
				},
			];
		});
		const serialized = JSON.stringify(watch);
		if (!force && serialized === lastPushedWatch) return;
		// Retry dropped watches.
		if (reached(sendOn(hostWs, JSON.stringify({ type: "presence_watch", watch }), "presence_watch")))
			lastPushedWatch = serialized;
	}
	const presenceWatchTimer = ambient.setInterval(() => pushPresenceWatch(), WATCH_PUSH_MS);

	return {
		liveHostSocket,
		readLiveness,
		wakeCoordinator,
		hostOpCoordinator,
		wakeService,
		relayToHost,
		pushPresenceWatch,
		presenceWatchTimer,
		installedAt: (spawn) => installedAt(sessions.hostSpawnPoints, spawn),
	};
}
