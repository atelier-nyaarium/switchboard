import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../../package.json";
import { debugLog } from "../shared/debug-log.js";
import { isInsideContainer } from "../shared/env.js";
import type { ChannelPushPayload } from "../shared/types.js";
import { registerBridgeDiscover } from "./bridge/bridgeDiscover.js";
import { registerBridgeSend } from "./bridge/bridgeSend.js";
import {
	closeRouter,
	connectToRouter,
	initBridge,
	routerGet,
	setChannelServer,
	setEvieToolsHandler,
	setIsMainOrLeadAgent,
} from "./bridge/helpers.js";
import { detectAgentType, registerBridgeTools } from "./bridge/registerBridgeTools.js";
import { emitChannelNotification } from "./channel/channelNotify.js";
import { registerConnectorTools } from "./connector/connectorTools.js";
import { setAuthToken, startListener, stopListener } from "./connector/listener.js";
import { registerProjectTools } from "./connector/projectTools.js";
import { registerStubTool } from "./connector/utils.js";
import { registerDevcontainerCli } from "./devcontainer/devcontainerCli.js";
import { registerDevcontainerExec } from "./devcontainer/devcontainerExec.js";
import { registerHostSessionPeek } from "./devcontainer/hostSessionPeek.js";
import { registerHostSessionSend } from "./devcontainer/hostSessionSend.js";
import { startHostWakeListener, stopHostWakeListener } from "./devcontainer/hostWakeListener.js";
import { registerReloadPlugins } from "./devcontainer/reloadPlugins.js";
import { registerSessionAwaitIdle } from "./devcontainer/sessionAwaitIdle.js";
import { registerSessionPeek } from "./devcontainer/sessionPeek.js";
import { registerSessionSend } from "./devcontainer/sessionSend.js";

////////////////////////////////
//  Functions & Helpers

const CHANNEL_INSTRUCTIONS = [
	'Cross-team messages arrive as <channel source="bridge"> tags with attributes: session_id, from, request_type, effort, is_follow_up.',
	"When you receive a channel message, read the request and do the work.",
	"When finished, call the channel_reply tool with the session_id from the tag attributes.",
].join(" ");

export async function startMcp(): Promise<void> {
	const inContainer = isInsideContainer();
	const agentType = inContainer ? process.env.AGENT_TYPE || detectAgentType() : "claude";
	const isChannel = inContainer && agentType === "claude";

	const needsChannel = agentType === "claude";

	const mcpServer = new McpServer(
		{ name: "agent-team-bridge", version: packageJson.version },
		needsChannel
			? {
					capabilities: { experimental: { "claude/channel": {} } },
					...(isChannel ? { instructions: CHANNEL_INSTRUCTIONS } : {}),
				}
			: undefined,
	);

	let routerAlreadyConnected = false;

	if (inContainer) {
		// Container: register crosstalk tools for cross-team communication
		registerBridgeTools(mcpServer);
		registerReloadPlugins(mcpServer);

		const projectName = process.env.PROJECT_NAME;
		const port = Number(process.env.MCP_CONNECTOR_PORT) || 20002;

		if (projectName) {
			const connectorDir = `/workspace/${projectName}/.claude/connector`;

			const tokenPath = `${connectorDir}/token`;
			if (fs.existsSync(tokenPath)) {
				setAuthToken(fs.readFileSync(tokenPath, "utf-8").trim());
				console.error(`[connector] Auth token loaded`);
			}

			// Best-effort start - port may be held by another IDE session
			try {
				startListener(port);
			} catch {
				console.error(`[connector] port ${port} in use, connector managed by another session`);
			}

			registerConnectorTools(mcpServer, projectName, connectorDir, port);
			await registerProjectTools(mcpServer, projectName, connectorDir);
		} else {
			registerStubTool(
				mcpServer,
				"projectMcpConnectorStatus",
				"Project MCP connector is disabled. Call this tool for details.",
				() =>
					[
						"Project MCP connector is disabled.",
						"",
						"Requirements:",
						"  - PROJECT_NAME env var must be set in the container",
						"  - MCP_CONNECTOR_PORT (default 20002) must be exposed via compose.yml",
					].join("\n"),
			);
		}
	} else {
		// Host: register dispatch tools for managing containers
		registerDevcontainerCli(mcpServer);
		registerDevcontainerExec(mcpServer);
		registerSessionPeek(mcpServer);
		registerSessionSend(mcpServer);
		registerSessionAwaitIdle(mcpServer);
		registerHostSessionPeek(mcpServer);
		registerHostSessionSend(mcpServer);
		registerReloadPlugins(mcpServer);

		// Init bridge for HTTP-only access (no WebSocket, just routerPost/routerGet)
		initBridge({
			routerUrl: process.env.BRIDGE_ROUTER_URL || "http://localhost:20000",
			projectName: "__arbiter__",
			agentType: "claude",
			effortEnv: {},
		});
		setIsMainOrLeadAgent(true);

		// Register crosstalk outgoing tools so the host can send to channel-connected containers
		registerBridgeSend(mcpServer);
		registerBridgeDiscover(mcpServer);
		setChannelServer(mcpServer.server);

		// Evie tool registration: try HTTP probe, then fall back to WebSocket push.
		// Tools MUST be registered before mcpServer.connect(transport) since Claude
		// does not pick up dynamically added tools after the initial advertisement.
		let evieToolsRegistered = false;
		let onEvieToolsRegistered: (() => void) | null = null;

		async function tryRegisterEvieTools(
			tools: import("../arbiter/evie/evieClient.js").EvieToolSchema[],
			source: string,
		): Promise<void> {
			if (evieToolsRegistered || tools.length === 0) {
				// #region Hypothesis Q: registration skipped
				debugLog("Q", "src/mcp/index.ts:tryRegisterEvieTools", "skipped", {
					source,
					alreadyRegistered: evieToolsRegistered,
					toolCount: tools.length,
				});
				// #endregion
				return;
			}
			try {
				const { registerEvieTools } = await import("./evie/evieTools.js");
				registerEvieTools(mcpServer, tools);
				evieToolsRegistered = true;
				onEvieToolsRegistered?.();
				// #region Hypothesis Q: registration succeeded
				debugLog("Q", "src/mcp/index.ts:tryRegisterEvieTools", "registered", {
					source,
					toolCount: tools.length,
				});
				// #endregion
			} catch (err) {
				// #region Hypothesis Q: registration failed (z.fromJSONSchema or other error)
				debugLog("Q", "src/mcp/index.ts:tryRegisterEvieTools", "registration error", {
					source,
					toolCount: tools.length,
					error: (err as Error).message,
				});
				// #endregion
				console.error(`[mcp] evie tool registration failed: ${(err as Error).message}`);
			}
		}

		// Listen for arbiter pushing tool schemas when evie connects/reconnects
		setEvieToolsHandler((tools) => {
			void tryRegisterEvieTools(tools as import("../arbiter/evie/evieClient.js").EvieToolSchema[], "ws-push");
		});

		// Fast path: HTTP probe for evie tools
		try {
			const health = (await routerGet("/health")) as Record<string, unknown>;
			if (health.ok) {
				const evieData = (await routerGet("/evie/tools")) as {
					tools?: import("../arbiter/evie/evieClient.js").EvieToolSchema[];
					error?: string;
				};
				// #region Hypothesis P: HTTP probe result
				debugLog("P", "src/mcp/index.ts:evieProbe", "HTTP probe result", {
					healthOk: true,
					toolCount: evieData.tools?.length ?? 0,
					error: evieData.error ?? null,
				});
				// #endregion
				if (evieData.tools) {
					await tryRegisterEvieTools(evieData.tools, "http-probe");
				}
			}
		} catch (err) {
			// #region Hypothesis P: HTTP probe failed
			debugLog("P", "src/mcp/index.ts:evieProbe", "HTTP probe failed", {
				error: (err as Error).message,
			});
			// #endregion
			console.error(`[mcp] arbiter not reachable via HTTP, will try WebSocket`);
		}

		// Slow path: connect WebSocket and wait for arbiter to push evie tools
		if (!evieToolsRegistered) {
			connectToRouter();
			routerAlreadyConnected = true;
			console.error(`[mcp] waiting for evie tools via WebSocket...`);
			const timedOut = await Promise.race([
				new Promise<false>((resolve) => {
					onEvieToolsRegistered = () => resolve(false);
				}),
				new Promise<true>((resolve) => setTimeout(() => resolve(true), 15_000)),
			]);
			// #region Hypothesis R: slow path outcome
			debugLog("R", "src/mcp/index.ts:evieSlowPath", "slow path completed", {
				timedOut,
				evieToolsRegistered,
			});
			// #endregion
			if (timedOut) {
				console.error(`[mcp] evie tools unavailable after 15s, continuing without`);
			}
		}

		const projectDirs = [path.join(os.homedir(), "projects")];
		startHostWakeListener(projectDirs, (msg) => {
			// Fallback: if __arbiter__ bridge is down, __host__ still delivers DMs
			const server = mcpServer.server;
			if (server) {
				emitChannelNotification(server, msg as unknown as ChannelPushPayload).catch((err: Error) => {
					console.error(`[host-wake] channel notification error: ${err.message}`);
				});
			}
		});
		console.error(`[mcp] dispatch + crosstalk tools enabled (host mode)`);
	}

	// #region Hypothesis S: transport connection timing relative to evie registration
	debugLog("S", "src/mcp/index.ts:transport", "connecting stdio transport", {
		inContainer,
		routerAlreadyConnected,
	});
	// #endregion
	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);

	// Container always connects after transport (no evie tools to wait for).
	// Host connects here only if evie tools arrived via HTTP probe (the slow
	// path above already connected the WebSocket when the probe failed).
	if (!routerAlreadyConnected) {
		connectToRouter();
	}

	const mode = inContainer
		? isChannel
			? "channel + crosstalk + connector"
			: "cli + crosstalk + connector"
		: "dispatch + crosstalk + channel";
	console.error(`[mcp] started (${mode})`);

	process.stdin.on("end", () => {
		console.error(`[mcp] stdin closed, shutting down`);
		closeRouter();
		stopListener();
		stopHostWakeListener();
		process.exit(0);
	});
}
