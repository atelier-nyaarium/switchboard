import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBridgeDiscover } from "./bridgeDiscover.js";
import { registerBridgeReply } from "./bridgeReply.js";
import { registerBridgeSend } from "./bridgeSend.js";
import { registerBridgeWait } from "./bridgeWait.js";
import { connectToRouter, initBridge } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

export function registerBridgeTools(mcpServer: McpServer): void {
	const projectName = process.env.PROJECT_NAME;

	if (!projectName) {
		// Register tools that return config error — agents see the tools exist but get a clear message
		const configError = {
			content: [
				{
					type: "text" as const,
					text: `Bridge is not configured. The PROJECT_NAME environment variable is missing from this container's devcontainer config.`,
				},
			],
			isError: true,
		};
		mcpServer.tool(
			"crosstalk_discover",
			`List all active teams on the bridge network.`,
			{},
			async () => configError,
		);
		mcpServer.tool("crosstalk_send", `Send a request to another team.`, {}, async () => configError);
		mcpServer.tool("crosstalk_reply", `Reply to an incoming bridge request.`, {}, async () => configError);
		mcpServer.tool("crosstalk_wait", `Wait N seconds before retrying.`, {}, async () => configError);
		return;
	}

	initBridge({
		routerUrl: process.env.BRIDGE_ROUTER_URL || "http://agent-team-bridge:5678",
		projectName,
		agentType: process.env.AGENT_TYPE || "claude",
		effortEnv: {
			simple: process.env.MODEL_SIMPLE || "auto",
			standard: process.env.MODEL_STANDARD || "auto",
			complex: process.env.MODEL_COMPLEX || "auto",
		},
	});

	registerBridgeDiscover(mcpServer);
	registerBridgeSend(mcpServer);
	registerBridgeReply(mcpServer);
	registerBridgeWait(mcpServer);

	connectToRouter();
}
