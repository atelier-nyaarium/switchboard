import type { ServerWebSocket } from "bun";
import type { Mutex } from "../shared/mutex.js";
import type { PendingEntry, WebSocketConfig } from "../shared/types.js";

////////////////////////////////
//  Interfaces & Types

export interface WebSocketDeps {
	registry: Map<string, ServerWebSocket<WsData>>;
	pendingCallbacks: Map<string, PendingEntry>;
	targetLocks: Map<string, Mutex>;
	config: WebSocketConfig;
}

export interface WsData {
	teamName: string | null;
	missedPings: number;
	isStale: boolean;
}

////////////////////////////////
//  Functions & Helpers

export function createWebSocketHandlers({ registry, pendingCallbacks, targetLocks, config }: WebSocketDeps) {
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
			console.log(`[ws] ${msg.team} connected`);
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

		if (registry.get(teamName) !== ws) {
			console.log(`[ws] stale close for ${teamName} - new socket already registered, skipping cleanup`);
			return;
		}

		registry.delete(teamName);
		console.log(`[ws] ${teamName} disconnected`);

		for (const [id, entry] of pendingCallbacks) {
			if (entry.to === teamName) {
				clearTimeout(entry.timer);
				pendingCallbacks.delete(id);
				entry.resolve({
					session_id: id,
					status: "error",
					message: `Team "${teamName}" disconnected before responding`,
				});
				console.log(`[ws] cancelled pending session ${id} (${teamName} disconnected)`);
			}
		}

		const mutex = targetLocks.get(teamName);
		if (mutex?.locked) {
			console.log(`[mutex] force-releasing ${teamName} after disconnect`);
			mutex.release();
		}
	}

	return { open, message, close, heartbeatInterval };
}
