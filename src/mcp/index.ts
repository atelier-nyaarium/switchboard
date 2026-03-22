import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../../package.json";
import { isInsideContainer } from "../shared/env.js";
import { registerBridgeDiscover } from "./bridge/bridgeDiscover.js";
import { registerBridgeSend } from "./bridge/bridgeSend.js";
import { closeRouter, connectToRouter, initBridge } from "./bridge/helpers.js";
import { detectAgentType, registerBridgeTools } from "./bridge/registerBridgeTools.js";
import { registerConnectorTools } from "./connector/connectorTools.js";
import { setAuthToken, startListener, stopListener } from "./connector/listener.js";
import { registerProjectTools } from "./connector/projectTools.js";
import { registerStubTool } from "./connector/utils.js";
import { registerDevcontainerCli } from "./devcontainer/devcontainerCli.js";
import { registerDevcontainerExec } from "./devcontainer/devcontainerExec.js";
import { startHostWakeListener, stopHostWakeListener } from "./devcontainer/hostWakeListener.js";

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

	const mcpServer = new McpServer(
		{ name: "agent-team-bridge", version: packageJson.version },
		isChannel
			? {
					capabilities: { experimental: { "claude/channel": {} } },
					instructions: CHANNEL_INSTRUCTIONS,
				}
			: undefined,
	);

	if (inContainer) {
		// Container: register crosstalk tools for cross-team communication
		registerBridgeTools(mcpServer);

		const projectName = process.env.PROJECT_NAME;
		const port = Number(process.env.MCP_CONNECTOR_PORT) || 20000;

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
						"  - MCP_CONNECTOR_PORT (default 20000) must be exposed via compose.yml",
					].join("\n"),
			);
		}
	} else {
		// Host: register dispatch tools for managing containers
		registerDevcontainerCli(mcpServer);
		registerDevcontainerExec(mcpServer);

		// Init bridge for HTTP-only access (no WebSocket, just routerPost/routerGet)
		initBridge({
			routerUrl: process.env.BRIDGE_ROUTER_URL || "http://localhost:20000",
			projectName: "__orchestrator__",
			agentType: "claude",
			effortEnv: {},
		});

		// Register crosstalk outgoing tools so the host can send to channel-connected containers
		registerBridgeSend(mcpServer);
		registerBridgeDiscover(mcpServer);

		const projectDirsEnv = process.env.DEVCONTAINER_PROJECT_DIRS;
		const projectDirs = projectDirsEnv ? projectDirsEnv.split(":").filter(Boolean) : undefined;
		startHostWakeListener(projectDirs);
		console.error(`[mcp] dispatch + crosstalk tools enabled (host mode)`);
	}

	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);

	if (inContainer) {
		connectToRouter();
	}

	const mode = inContainer
		? isChannel
			? "channel + crosstalk + connector"
			: "cli + crosstalk + connector"
		: "dispatch + crosstalk";
	console.error(`[mcp] started (${mode})`);

	process.stdin.on("end", () => {
		console.error(`[mcp] stdin closed, shutting down`);
		closeRouter();
		stopListener();
		stopHostWakeListener();
		process.exit(0);
	});
}
