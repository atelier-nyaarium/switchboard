import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execSync } from "node:child_process";
import { registerBridgeDiscover } from "./bridgeDiscover.js";
import { registerBridgeReply } from "./bridgeReply.js";
import { registerBridgeSend } from "./bridgeSend.js";
import { registerBridgeWait } from "./bridgeWait.js";
import { connectToRouter, initBridge } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

const AGENT_CLI_NAMES: Record<string, string> = {
	claude: "claude",
	cursor: "cursor-agent",
	copilot: "copilot",
	codex: "codex",
};

function detectAgentType(): string {
	for (const [agentType, cli] of Object.entries(AGENT_CLI_NAMES)) {
		try {
			execSync(`which ${cli}`, { stdio: "ignore" });
			return agentType;
		} catch {
			// Not found, try next
		}
	}
	return "claude";
}

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
		agentType: process.env.AGENT_TYPE || detectAgentType(),
		effortEnv: {
			simple: process.env.MODEL_SIMPLE,
			standard: process.env.MODEL_STANDARD,
			complex: process.env.MODEL_COMPLEX,
		},
	});

	registerBridgeDiscover(mcpServer);
	registerBridgeSend(mcpServer);
	registerBridgeReply(mcpServer);
	registerBridgeWait(mcpServer);

	connectToRouter();
}
