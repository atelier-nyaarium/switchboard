import type { ServerWebSocket } from "bun";
import type { Mutex } from "../shared/mutex.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload, WebSocketConfig } from "../shared/types.js";
import type { WakeCoordinator } from "./wake.js";

////////////////////////////////
//  Interfaces & Types

export interface WebSocketDeps {
	registry: Map<string, ServerWebSocket<WsData>>;
	store: PendingJobStore<ResponsePayload>;
	targetLocks: Map<string, Mutex>;
	knownTeamPaths: Map<string, string>;
	offlineCatalog: Map<string, string>;
	wakeCoordinator: WakeCoordinator;
	config: WebSocketConfig;
}

export interface WsData {
	teamName: string | null;
	missedPings: number;
	isStale: boolean;
	proxyProject?: string;
	proxyAuth?: string;
}

////////////////////////////////
//  Functions & Helpers

export function createWebSocketHandlers({
	registry,
	store,
	targetLocks,
	knownTeamPaths,
	offlineCatalog,
	wakeCoordinator,
	config,
}: WebSocketDeps) {
	const { HEARTBEAT_INTERVAL_MS = 30000, MISSED_PINGS_LIMIT = 2 } = config;

	const heartbeatInterval = setInterval(() => {
		for (const [, ws] of registry) {
			const data = ws.data as WsData;
			data.missedPings = (data.missedPings || 0) + 1;
			if (data.missedPings >= MISSED_PINGS_LIMIT) {
				ws.close();
				continue;
			}
			ws.ping();
		}
	}, HEARTBEAT_INTERVAL_MS);

	function open(ws: ServerWebSocket<WsData>): void {
		ws.data.missedPings = 0;
		ws.data.isStale = false;
	}

	function message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			return;
		}

		if (msg.type === "register") {
			const team = msg.team as string;
			const existing = registry.get(team);
			if (existing && existing !== ws) {
				console.log(`[ws] ${team} re-registered - closing stale socket`);
				existing.data.isStale = true;
				existing.close();
			}
			ws.data.teamName = team;
			registry.set(team, ws);

			if (typeof msg.projectPath === "string" && msg.projectPath) {
				knownTeamPaths.set(team, msg.projectPath);
			}

			wakeCoordinator.notify(team);
			console.log(`[ws] ${team} connected`);
		}

		if (msg.type === "wake_result" && msg.success === false && typeof msg.team === "string") {
			wakeCoordinator.notify(msg.team, false);
		}

		if (msg.type === "catalog" && ws.data.teamName === "__host__") {
			const projects = msg.projects;
			if (Array.isArray(projects)) {
				offlineCatalog.clear();
				for (const p of projects) {
					if (typeof p.team === "string" && typeof p.projectPath === "string") {
						offlineCatalog.set(p.team, p.projectPath);
						if (!knownTeamPaths.has(p.team)) {
							knownTeamPaths.set(p.team, p.projectPath);
						}
					}
				}
				console.log(`[ws] catalog received: ${offlineCatalog.size} projects`);
			}
		}

		// Reset missed pings on any message (acts like pong)
		ws.data.missedPings = 0;
	}

	function close(ws: ServerWebSocket<WsData>): void {
		const teamName = ws.data.teamName;

		if (ws.data.isStale) {
			console.log(`[ws] stale socket closed for ${teamName} - ignoring`);
			return;
		}

		if (!teamName) return;

		if (teamName === "__host__") {
			registry.delete(teamName);
			offlineCatalog.clear();
			console.log(`[ws] __host__ disconnected - offline catalog cleared`);
			return;
		}

		if (registry.get(teamName) !== ws) {
			console.log(`[ws] stale close for ${teamName} - new socket already registered, skipping cleanup`);
			return;
		}

		registry.delete(teamName);
		console.log(`[ws] ${teamName} disconnected`);

		for (const id of store.getIdsForTeam(teamName)) {
			store.deliver(id, {
				session_id: id,
				status: "error",
				message: `Team "${teamName}" disconnected before responding`,
			} as ResponsePayload);
			console.log(`[ws] cancelled pending session ${id} (${teamName} disconnected)`);
		}

		const mutex = targetLocks.get(teamName);
		if (mutex?.locked) {
			console.log(`[mutex] force-releasing ${teamName} after disconnect`);
			mutex.release();
		}
	}

	return { open, message, close, heartbeatInterval };
}
