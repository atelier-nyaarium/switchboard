import path from "node:path";
import type { ServerWebSocket } from "bun";
import { getMutex, type Mutex } from "../shared/mutex.js";
import type { PendingEntry } from "../shared/types.js";
import { createRoutes } from "./routes.js";
import { createWebSocketHandlers, type WsData } from "./websocket.js";

////////////////////////////////
//  Interfaces & Types

interface MutexAccessor {
	(team: string): Mutex;
	peek: (team: string) => Mutex | undefined;
}

////////////////////////////////
//  Functions & Helpers

export function startArbiter(): void {
	const PORT = parseInt(process.env.PORT || "5678", 10);
	const LOG_PATH = path.join("/app", "log", "debug.log");
	const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || "600000", 10);
	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, ServerWebSocket<WsData>>();
	const pendingCallbacks = new Map<string, PendingEntry>();
	const targetLocks = new Map<string, Mutex>();

	const getMutexForTeam: MutexAccessor = Object.assign((team: string) => getMutex(targetLocks, team), {
		peek: (team: string) => targetLocks.get(team),
	});

	const routes = createRoutes({
		registry,
		pendingCallbacks,
		getMutex: getMutexForTeam,
		config: { LOG_PATH, RESPONSE_TIMEOUT_MS },
	});

	const wsHandlers = createWebSocketHandlers({
		registry,
		pendingCallbacks,
		targetLocks,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT },
	});

	async function router(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const method = req.method;

		let body: Record<string, unknown> = {};
		if (method === "POST") {
			try {
				body = await req.json();
			} catch {
				return new Response(JSON.stringify({ error: `Invalid JSON` }), {
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
			if (server.upgrade(req, { data: { teamName: null, missedPings: 0, isStale: false } })) {
				return;
			}
			return router(req);
		},
		websocket: {
			open: wsHandlers.open,
			message: wsHandlers.message,
			close: wsHandlers.close,
		},
	});

	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
}
