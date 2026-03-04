import type { ServerWebSocket } from "bun";
import type { Mutex } from "../shared/mutex.js";
import type { PendingEntry, WebSocketConfig } from "../shared/types.js";

export interface WebSocketDeps {
	registry: Map<string, ServerWebSocket<{ teamName: string | null }>>;
	pendingCallbacks: Map<string, PendingEntry>;
	targetLocks: Map<string, Mutex>;
	config: WebSocketConfig;
}

export interface WsData {
	teamName: string | null;
	missedPings: number;
}

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

	function open(ws: ServerWebSocket<WsData>) {
		ws.data.missedPings = 0;
	}

	function message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
		let msg: any;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			return;
		}

		if (msg.type === "register") {
			const existing = registry.get(msg.team);
			if (existing && existing !== (ws as any)) {
				console.log(`[ws] ${msg.team} re-registered - closing stale socket`);
				existing.close();
			}
			ws.data.teamName = msg.team;
			registry.set(msg.team, ws as any);
			console.log(`[ws] ${msg.team} connected`);
		}

		// Reset missed pings on any message (acts like pong)
		ws.data.missedPings = 0;
	}

	function close(ws: ServerWebSocket<WsData>) {
		const teamName = ws.data.teamName;
		if (!teamName) return;

		if (registry.get(teamName) !== (ws as any)) {
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
		if (mutex && mutex.locked) {
			console.log(`[mutex] force-releasing ${teamName} after disconnect`);
			mutex.release();
		}
	}

	return { open, message, close, heartbeatInterval };
}
