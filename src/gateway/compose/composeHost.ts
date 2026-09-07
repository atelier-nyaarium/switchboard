// The host daemon socket and everything routed over it.

import type { ServerWebSocket } from "bun";
import type { Ambient, IntervalHandle } from "../../shared/ambient.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { HostOpCoordinator } from "../hostOpCoordinator.js";
import { WakeCoordinator } from "../wake.js";
import { WakeService } from "../wakeService.js";
import { reached, sendOn } from "../wsSend.js";
import { resolveLiveIncarnation, type WsData } from "../wsTypes.js";
import type { SessionsStage } from "./composeSessions.js";

const HOST_OP_TIMEOUT_MS = 20_000;

export interface HostStageDeps {
	sessions: Pick<
		SessionsStage,
		| "registry"
		| "sessionStore"
		| "presence"
		| "isAvailableProject"
		| "knownTeamPaths"
		| "offlineCatalog"
		| "intentTracker"
	>;
	wakeTimeoutMs: number;
	ambient: Ambient;
}

export interface HostStage {
	liveHostSocket: () => ServerWebSocket<WsData> | undefined;
	wakeCoordinator: WakeCoordinator;
	hostOpCoordinator: HostOpCoordinator;
	wakeService: WakeService;
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
	/** Re-sends the watch list; `force` re-sends an unchanged one. */
	pushPresenceWatch: (force?: boolean) => void;
	presenceWatchTimer: IntervalHandle;
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
	});

	async function relayToHost(op: HostOp): Promise<HostOpResult> {
		const hostWs = liveHostSocket();
		if (!hostWs) return { ok: false, error: "host daemon offline - terminal unavailable" };
		const reqId = ambient.randomBytes(8).toString("hex");
		// Dropped requests never answer.
		if (!reached(sendOn(hostWs, JSON.stringify({ type: "host_op", reqId, op }), `host_op ${op.kind}`)))
			return { ok: false, error: "the host daemon did not take the request" };
		return hostOpCoordinator.wait(reqId, HOST_OP_TIMEOUT_MS);
	}

	let lastPushedWatch = "";
	function pushPresenceWatch(force = false): void {
		const hostWs = liveHostSocket();
		if (!hostWs) return;
		const liveTeams = sessions.presence
			.snapshot()
			.filter((row) => row.status === "online" || row.status === "verifying")
			.map((row) => row.team);
		const watch = sessions.intentTracker.watchList(liveTeams);
		const serialized = JSON.stringify(watch);
		if (!force && serialized === lastPushedWatch) return;
		// Retry dropped watches.
		if (reached(sendOn(hostWs, JSON.stringify({ type: "presence_watch", watch }), "presence_watch")))
			lastPushedWatch = serialized;
	}
	const presenceWatchTimer = ambient.setInterval(() => pushPresenceWatch(), 2_000);

	return {
		liveHostSocket,
		wakeCoordinator,
		hostOpCoordinator,
		wakeService,
		relayToHost,
		pushPresenceWatch,
		presenceWatchTimer,
	};
}
