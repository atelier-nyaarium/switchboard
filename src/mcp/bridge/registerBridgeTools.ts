import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBridgeDiscover } from "./bridgeDiscover.js";
import { registerBridgeReply } from "./bridgeReply.js";
import { registerBridgeSend } from "./bridgeSend.js";
import { registerBridgeWait } from "./bridgeWait.js";
import { connectToRouter, initBridge } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

export function registerBridgeTools(mcpServer: McpServer): void {
	initBridge({
		routerUrl: process.env.BRIDGE_ROUTER_URL || "http://agent-team-bridge:5678",
		projectName: process.env.PROJECT_NAME!,
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
	console.error(`[bridge] tools enabled for "${process.env.PROJECT_NAME}"`);
}
