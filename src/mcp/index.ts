import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeRouter } from "./bridge/helpers.js";
import { registerBridgeTools } from "./bridge/registerBridgeTools.js";
import { registerDevcontainerChat } from "./devcontainer/devcontainerChat.js";
import { registerDevcontainerExec } from "./devcontainer/devcontainerExec.js";

////////////////////////////////
//  Functions & Helpers

function isInsideContainer(): boolean {
	return fs.existsSync("/.dockerenv") || !!process.env.REMOTE_CONTAINERS;
}

export async function startMcp(): Promise<void> {
	const mcpServer = new McpServer({
		name: "agent-team-bridge",
		version: "0.5.0",
	});

	const inContainer = isInsideContainer();

	if (inContainer) {
		// Container: register bridge tools for cross-team communication
		registerBridgeTools(mcpServer);
	} else {
		// Host: register devcontainer tools for managing containers
		registerDevcontainerChat(mcpServer);
		registerDevcontainerExec(mcpServer);
		console.error(`[mcp] devcontainer tools enabled (host mode)`);
	}

	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);

	const mode = inContainer ? "bridge" : "devcontainer";
	console.error(`[mcp] started (${mode})`);

	process.stdin.on("end", () => {
		console.error(`[mcp] stdin closed, shutting down`);
		closeRouter();
		process.exit(0);
	});
}
