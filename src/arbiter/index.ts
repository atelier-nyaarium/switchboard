import crypto from "node:crypto";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { getMutex, type Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ChannelPushPayload, ResponsePayload } from "../shared/types.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { startEvieClient } from "./evie/evieClient.js";
import { startPortForward } from "./evie/portForward.js";
import { createRoutes } from "./routes.js";
import { WakeCoordinator } from "./wake.js";
import { createWebSocketHandlers, getAllActiveWs, type WsData } from "./websocket.js";

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

	// Start evie-bot bridge if config is present
	const evieAuthToken = process.env.BRIDGE_TOKEN;
	const evieKubeconfig = process.env.EVIE_KUBECONFIG || "/app/kubeconfig.yaml";
	const evieNamespace = process.env.EVIE_NAMESPACE || "evie-bot";
	const evieDeploymentLabel = process.env.EVIE_DEPLOYMENT_LABEL || "app=evie-bot-app";
	const eviePort = parseInt(process.env.EVIE_BRIDGE_PORT || "20001", 10);
	const evieLocalPort = parseInt(process.env.EVIE_LOCAL_PORT || "20001", 10);

	let evieClient: ReturnType<typeof startEvieClient> | null = null;

	if (evieAuthToken) {
		const portForward = startPortForward({
			kubeconfig: evieKubeconfig,
			namespace: evieNamespace,
			deploymentLabel: evieDeploymentLabel,
			remotePort: eviePort,
			localPort: evieLocalPort,
		});

		// Port-forward needs a moment before the tunnel is ready
		await new Promise((r) => setTimeout(r, 3_000));

		evieClient = startEvieClient({
			url: `ws://localhost:${evieLocalPort}`,
			authToken: evieAuthToken,
			onToolRegistry: (tools) => {
				console.log(`[evie] received ${tools.length} tools`);
				// Push tool schemas to orchestrator so it can register them dynamically
				const orchestratorSubs = registry.get("__orchestrator__");
				if (orchestratorSubs) {
					const payload = JSON.stringify({ type: "evie_tools", tools });
					for (const ws of getAllActiveWs(orchestratorSubs)) {
						ws.send(payload);
					}
					console.log(`[evie] pushed tool schemas to __orchestrator__`);
				}
			},
			onDmForward: (dm) => {
				const orchestratorSubs = registry.get("__orchestrator__");
				if (!orchestratorSubs) {
					console.error(`[evie] DM forward dropped: no __orchestrator__ registered`);
					return;
				}
				const activeWs = getAllActiveWs(orchestratorSubs);
				if (activeWs.length === 0) {
					console.error(`[evie] DM forward dropped: __orchestrator__ has no active connections`);
					return;
				}

				const sessionId = crypto.randomUUID();
				const payload: ChannelPushPayload = {
					type: "channel_push",
					from: "discord",
					request_type: "question",
					body: `[channelId: ${dm.channelId}]\n\n${dm.content}`,
					effort: "standard",
					session_id: sessionId,
					is_follow_up: false,
				};

				const serialized = JSON.stringify(payload);
				for (const ws of activeWs) {
					ws.send(serialized);
				}
				console.log(`[evie] DM forwarded to __orchestrator__ [${sessionId.slice(0, 8)}...]`);
			},
			onDisconnect: () => {
				console.error(`[evie] disconnected from evie-bot`);
			},
		});

		process.on("SIGTERM", () => {
			evieClient?.stop();
			portForward.stop();
		});
	}

	const routes = createRoutes({
		registry,
		store,
		getMutex: getMutexForTeam,
		config: { LOG_PATH, RESPONSE_TIMEOUT_MS },
		tryWakeTeam,
		offlineCatalog,
		evieClient,
	});

	const wsHandlers = createWebSocketHandlers({
		registry,
		store,
		targetLocks,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT },
		knownTeamPaths,
		offlineCatalog,
		wakeCoordinator,
		onTeamConnect: (team, ws) => {
			// When orchestrator connects, push cached evie tools if available
			if (team === "__orchestrator__" && evieClient?.isConnected()) {
				const tools = evieClient.getToolSchemas();
				if (tools.length > 0) {
					ws.send(JSON.stringify({ type: "evie_tools", tools }));
					console.log(`[evie] pushed ${tools.length} cached tool schemas to new __orchestrator__`);
				}
			}
		},
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
		if (method === "GET" && url.pathname === "/evie/tools") return routes.evieTools();
		if (method === "POST" && url.pathname === "/evie/tool-call") return routes.evieToolCall(req, body);

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
