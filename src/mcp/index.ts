import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeRouter } from "./bridge/helpers.js";
import { registerBridgeTools } from "./bridge/registerBridgeTools.js";
import { registerConnectorTools } from "./connector/connectorTools.js";
import { setAuthToken, startListener, stopListener } from "./connector/listener.js";
import { registerProjectTools } from "./connector/projectTools.js";
import { registerStubTool } from "./connector/utils.js";
import { registerDevcontainerChat } from "./devcontainer/devcontainerChat.js";
import { registerDevcontainerExec } from "./devcontainer/devcontainerExec.js";
import { startHostWakeListener, stopHostWakeListener } from "./devcontainer/hostWakeListener.js";

////////////////////////////////
//  Functions & Helpers

function isInsideContainer(): boolean {
	return fs.existsSync("/.dockerenv") || !!process.env.REMOTE_CONTAINERS;
}

export async function startMcp(): Promise<void> {
	const mcpServer = new McpServer({
		name: "agent-team-bridge",
		version: "0.6.0",
	});

	const inContainer = isInsideContainer();

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

			startListener(port);
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
		registerDevcontainerChat(mcpServer);
		registerDevcontainerExec(mcpServer);
		startHostWakeListener();
		console.error(`[mcp] dispatch tools enabled (host mode)`);
	}

	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);

	const mode = inContainer ? "crosstalk + connector" : "dispatch";
	console.error(`[mcp] started (${mode})`);

	process.stdin.on("end", () => {
		console.error(`[mcp] stdin closed, shutting down`);
		closeRouter();
		stopListener();
		stopHostWakeListener();
		process.exit(0);
	});
}
