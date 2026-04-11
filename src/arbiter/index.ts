import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { debugLog } from "../shared/debug-log.js";
import { getMutex, type Mutex } from "../shared/mutex.js";
import { PendingJobStore } from "../shared/pending-job-store.js";
import type { ChannelPushPayload, ResponsePayload } from "../shared/types.js";
import { handleProxyClose, handleProxyMessage, isProxyConnection, setupProxy } from "./connectorProxy.js";
import { type DmForwardPayload, startEvieClient } from "./evie/evieClient.js";
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

	// Clear debug log on startup so it only contains entries from this run
	try {
		const dir = path.dirname(LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(LOG_PATH, "");
	} catch {}

	const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || "600000", 10);
	const WAKE_TIMEOUT_MS = parseInt(process.env.WAKE_TIMEOUT_MS || "600000", 10);
	const HEARTBEAT_INTERVAL_MS = 30000;
	const MISSED_PINGS_LIMIT = 2;

	const registry = new Map<string, Map<string, ServerWebSocket<WsData>>>();
	const conversationRegistry = new Map<string, ServerWebSocket<WsData>>();
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

		// #region Hypothesis I: check __host__ WebSocket state when wake fires
		const hostSubCount = hostSubs?.size ?? 0;
		const hostWsStates = hostSubs ? [...hostSubs.values()].map((ws) => ws.readyState) : [];
		console.log(
			`[wake] __host__ state: subs=${hostSubCount}, readyStates=[${hostWsStates.join(",")}], foundAlive=${!!hostWs}`,
		);
		// #endregion

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

	const dmQueue: Array<{ dm: DmForwardPayload; queuedAt: number }> = [];
	const DM_QUEUE_TTL_MS = 600_000;
	const DM_QUEUE_MAX = 50;

	// DMs go to the orchestrator or the host daemon.
	// The orchestrator can delegate to a specific project if needed.
	const DM_TARGETS = ["__arbiter__", "__host__"];

	function tryDeliverDm(dm: DmForwardPayload): boolean {
		// #region Hypothesis N: DM delivery attempt with registry state
		const registrySnapshot: Record<string, number> = {};
		for (const target of DM_TARGETS) {
			const subs = registry.get(target);
			registrySnapshot[target] = subs ? getAllActiveWs(subs).length : 0;
		}
		debugLog(
			"N",
			"src/arbiter/index.ts:tryDeliverDm",
			"attempting delivery",
			{
				userId: dm.userId,
				channelId: dm.channelId,
				bodyLen: dm.content.length,
				targetState: registrySnapshot,
			},
			"arbiter",
		);
		// #endregion

		for (const target of DM_TARGETS) {
			const subs = registry.get(target);
			const activeWs = subs ? getAllActiveWs(subs) : [];
			if (activeWs.length === 0) continue;

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

			// #region Hypothesis N: DM delivered successfully
			debugLog(
				"N",
				"src/arbiter/index.ts:tryDeliverDm",
				"delivered",
				{
					target,
					sessionId: sessionId.slice(0, 8),
					activeWsCount: activeWs.length,
				},
				"arbiter",
			);
			// #endregion

			console.log(`[evie] DM forwarded to ${target} [${sessionId.slice(0, 8)}...]`);
			return true;
		}

		// #region Hypothesis N: DM delivery failed, will be queued
		debugLog(
			"N",
			"src/arbiter/index.ts:tryDeliverDm",
			"no available target",
			{
				userId: dm.userId,
				registryState: registrySnapshot,
				allTeams: [...registry.keys()],
			},
			"arbiter",
		);
		// #endregion

		return false;
	}

	if (evieAuthToken) {
		const dmQueueSweep = setInterval(() => {
			const now = Date.now();
			for (let i = dmQueue.length - 1; i >= 0; i--) {
				if (now - dmQueue[i].queuedAt > DM_QUEUE_TTL_MS) {
					console.log(`[evie] queued DM expired after ${DM_QUEUE_TTL_MS / 1000}s`);
					dmQueue.splice(i, 1);
				}
			}
		}, 60_000);

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
				const orchestratorSubs = registry.get("__arbiter__");
				if (orchestratorSubs) {
					const payload = JSON.stringify({ type: "evie_tools", tools });
					for (const ws of getAllActiveWs(orchestratorSubs)) {
						ws.send(payload);
					}
					console.log(`[evie] pushed tool schemas to __arbiter__`);
				}
			},
			onDmForward: (dm) => {
				if (tryDeliverDm(dm)) return;

				if (dmQueue.length >= DM_QUEUE_MAX) {
					console.error(`[evie] DM queue full, dropping oldest`);
					dmQueue.shift();
				}
				dmQueue.push({ dm, queuedAt: Date.now() });
				console.log(`[evie] DM queued (${dmQueue.length} pending)`);
			},
			onDisconnect: () => {
				console.error(`[evie] disconnected from evie-bot`);
			},
		});

		process.on("SIGTERM", () => {
			clearInterval(dmQueueSweep);
			evieClient?.stop();
			portForward.stop();
		});
	}

	const wsHandlers = createWebSocketHandlers({
		registry,
		conversationRegistry,
		store,
		targetLocks,
		config: { HEARTBEAT_INTERVAL_MS, MISSED_PINGS_LIMIT },
		knownTeamPaths,
		offlineCatalog,
		wakeCoordinator,
		onTeamConnect: (team, ws) => {
			// When orchestrator connects, push cached evie tools if available
			if (team === "__arbiter__" && evieClient?.isConnected()) {
				const tools = evieClient.getToolSchemas();
				if (tools.length > 0) {
					ws.send(JSON.stringify({ type: "evie_tools", tools }));
					console.log(`[evie] pushed ${tools.length} cached tool schemas to new __arbiter__`);
				}
			}

			// Drain queued DMs now that a potential target is online
			if (dmQueue.length > 0) {
				let drained = 0;
				for (let i = dmQueue.length - 1; i >= 0; i--) {
					if (tryDeliverDm(dmQueue[i].dm)) {
						dmQueue.splice(i, 1);
						drained++;
					}
				}
				if (drained > 0) {
					console.log(`[evie] drained ${drained} queued DM(s) after ${team} connected`);
				}
			}
		},
	});

	const routes = createRoutes({
		registry,
		conversationRegistry,
		store,
		getMutex: getMutexForTeam,
		config: { LOG_PATH, RESPONSE_TIMEOUT_MS },
		tryWakeTeam,
		offlineCatalog,
		evieClient,
		resolveHandshake: wsHandlers.resolveHandshake,
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
							conversationId: null,
							mode: "cli" as const,
							missedPings: 0,
							isStale: false,
							handshakeConfirmed: false,
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
						data: {
							teamName: null,
							subId: "",
							conversationId: null,
							mode: "cli" as const,
							missedPings: 0,
							isStale: false,
							handshakeConfirmed: false,
						},
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
