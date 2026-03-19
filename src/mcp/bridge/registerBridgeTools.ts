import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
		// Register tools that return config error so agents see the tools exist but get a clear message
		const configError = {
			content: [
				{
					type: "text" as const,
					text: `Bridge is not configured. The PROJECT_NAME environment variable is missing from this container's devcontainer config.`,
				},
			],
			isError: true,
		};
		mcpServer.registerTool(
			"crosstalk_discover",
			{
				title: "Crosstalk Discover",
				description: `List all active teams on the bridge network.`,
				inputSchema: {},
			},
			async () => configError,
		);
		mcpServer.registerTool(
			"crosstalk_send",
			{ title: "Crosstalk Send", description: `Send a request to another team.`, inputSchema: {} },
			async () => configError,
		);
		mcpServer.registerTool(
			"crosstalk_reply",
			{ title: "Crosstalk Reply", description: `Reply to an incoming bridge request.`, inputSchema: {} },
			async () => configError,
		);
		mcpServer.registerTool(
			"crosstalk_wait",
			{ title: "Crosstalk Wait", description: `Wait N seconds before retrying.`, inputSchema: {} },
			async () => configError,
		);
		return;
	}

	initBridge({
		routerUrl: process.env.BRIDGE_ROUTER_URL || "http://agent-team-bridge:20000",
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
