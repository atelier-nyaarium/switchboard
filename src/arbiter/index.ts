import path from "node:path";
import type { ServerWebSocket } from "bun";
import { getMutex, type Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ResponsePayload } from "../shared/types.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { startDiscordRelay } from "./discord/discordClient.js";
import { createRoutes } from "./routes.js";
import { WakeCoordinator } from "./wake.js";
import { createWebSocketHandlers, type WsData } from "./websocket.js";

////////////////////////////////
//  Interfaces & Types

interface MutexAccessor {
	(team: string): Mutex;
	peek: (team: string) => Mutex | undefined;
}

////////////////////////////////
//  Functions & Helpers

export async function startArbiter(): Promise<void> {
	const PORT = parseInt(process.env.PORT || "20000", 10);
	const LOG_PATH = path.join("/app", "log", "debug.log");
	const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || "600000", 10);
	const WAKE_TIMEOUT_MS = parseInt(process.env.WAKE_TIMEOUT_MS || "120000", 10);
	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, Map<string, ServerWebSocket<WsData>>>();
	const store = new PendingJobStore<ResponsePayload>();
	const targetLocks = new Map<string, Mutex>();
	const knownTeamPaths = new Map<string, string>();
	const offlineCatalog = new Map<string, string>();
	const wakeCoordinator = new WakeCoordinator();

	store.startCleanup();

	const getMutexForTeam: MutexAccessor = Object.assign((team: string) => getMutex(targetLocks, team), {
		peek: (team: string) => targetLocks.get(team),
	});

	async function tryWakeTeam(team: string): Promise<boolean> {
		const hostSubs = registry.get("__host__");
		const hostWs = hostSubs ? [...hostSubs.values()].find((ws) => ws.readyState === 1) : undefined;
		if (!hostWs) {
			console.log(`[wake] cannot wake ${team} - __host__ is not connected`);
			return false;
		}

		const projectPath = knownTeamPaths.get(team);
		hostWs.send(
			JSON.stringify({
				type: "wake",
				team,
				...(projectPath ? { projectPath } : {}),
			}),
		);

		console.log(`[wake] requesting ${team} startup${projectPath ? ` (${projectPath})` : " (convention)"}`);

		const success = await wakeCoordinator.waitFor(team, WAKE_TIMEOUT_MS);
		console.log(`[wake] ${team} ${success ? "is now online" : "failed to come online"}`);
		return success;
	}

	// Start Discord relay if all required env vars are present
	const hasDiscord = process.env.DISCORD_CLIENT_ID && process.env.DISCORD_SECRET_KEY && process.env.DISCORD_OWNER_ID;
	const discordRelay = hasDiscord ? await startDiscordRelay({ registry }) : null;

	const routes = createRoutes({
		registry,
		store,
		getMutex: getMutexForTeam,
		config: { LOG_PATH, RESPONSE_TIMEOUT_MS },
		tryWakeTeam,
		offlineCatalog,
		discordRelay,
	});

	const wsHandlers = createWebSocketHandlers({
		registry,
		store,
		targetLocks,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT },
		knownTeamPaths,
		offlineCatalog,
		wakeCoordinator,
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
		if (method === "POST" && url.pathname === "/poll") return routes.poll(req, body);
		if (method === "GET" && url.pathname === "/health") return routes.health();
		if (method === "POST" && url.pathname === "/discord/reply") return routes.discordReply(req, body);

		return new Response("Not Found", { status: 404 });
	}

	Bun.serve<WsData>({
		port: PORT,
		fetch(req, server) {
			const url = new URL(req.url);

			// Connector proxy: /connector/{project}/ws
			const proxyMatch = url.pathname.match(/^\/connector\/([^/]+)\/ws$/);
			if (proxyMatch) {
				const project = proxyMatch[1];
				const authHeader = req.headers.get("Authorization") || "";
				if (
					server.upgrade(req, {
						data: {
							teamName: null,
							subId: "",
							mode: "cli" as const,
							missedPings: 0,
							isStale: false,
							proxyProject: project,
							proxyAuth: authHeader,
						},
					})
				) {
					return;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Team/host registration: /bridge
			if (url.pathname === "/bridge") {
				if (
					server.upgrade(req, {
						data: { teamName: null, subId: "", mode: "cli" as const, missedPings: 0, isStale: false },
					})
				) {
					return;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			return router(req);
		},
		websocket: {
			open(ws) {
				if (ws.data.proxyProject) {
					setupProxy(ws, ws.data.proxyProject, ws.data.proxyAuth || "");
					return;
				}
				wsHandlers.open(ws);
			},
			message(ws, raw) {
				if (isProxyConnection(ws)) {
					handleProxyMessage(ws, raw);
					return;
				}
				wsHandlers.message(ws, raw);
			},
			close(ws) {
				if (isProxyConnection(ws)) {
					handleProxyClose(ws);
					return;
				}
				wsHandlers.close(ws);
			},
			pong(ws) {
				ws.data.missedPings = 0;
			},
		},
	});

	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
}
