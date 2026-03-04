import path from "path";

import { getMutex, Mutex } from "../shared/mutex.js";
import type { PendingEntry } from "../shared/types.js";
import { createRoutes } from "./routes.js";
import { createWebSocketHandlers, type WsData } from "./websocket.js";

import type { ServerWebSocket } from "bun";

export function startArbiter() {
	const PORT = parseInt(process.env.PORT || "5678");
	const LOG_PATH = path.join("/app", "log", "debug.log");
	const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || "600000");
	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, ServerWebSocket<WsData>>();
	const pendingCallbacks = new Map<string, PendingEntry>();
	const targetLocks = new Map<string, Mutex>();

	const getMutexForTeam = ((team: string) => getMutex(targetLocks, team)) as ((team: string) => Mutex) & {
		peek: (team: string) => Mutex | undefined;
	};
	getMutexForTeam.peek = (team: string) => targetLocks.get(team);

	const routes = createRoutes({
		registry: registry as any,
		pendingCallbacks,
		getMutex: getMutexForTeam,
		config: { LOG_PATH, RESPONSE_TIMEOUT_MS },
	});

	const wsHandlers = createWebSocketHandlers({
		registry: registry as any,
		pendingCallbacks,
		targetLocks,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT },
	});

	async function router(req: Request, server: any): Promise<Response> {
		const url = new URL(req.url);
		const method = req.method;

		let body: any = null;
		if (method === "POST") {
			try {
				body = await req.json();
			} catch {
				return new Response(JSON.stringify({ error: "Invalid JSON" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		if (method === "POST" && url.pathname === "/ingest") return routes.ingest(req, body);
		if (method === "GET" && url.pathname === "/pending") return routes.pending();
		if (method === "GET" && url.pathname === "/teams") return routes.teams();
		if (method === "POST" && url.pathname === "/send") return routes.send(req, body);
		if (method === "POST" && url.pathname === "/respond") return routes.respond(req, body);
		if (method === "GET" && url.pathname === "/health") return routes.health();

		return new Response("Not Found", { status: 404 });
	}

	Bun.serve({
		port: PORT,
		fetch(req, server) {
			if (server.upgrade(req, { data: { teamName: null, missedPings: 0 } })) {
				return;
			}
			return router(req, server);
		},
		websocket: {
			open: wsHandlers.open,
			message: wsHandlers.message,
			close: wsHandlers.close,
		},
	});

	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
}
