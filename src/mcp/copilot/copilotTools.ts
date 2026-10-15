import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentHttpPath, COPILOT_BACKEND } from "../../shared/agent-backend.js";
import {
	CopilotAwaitAgentInputSchema,
	CopilotListAgentsInputSchema,
	CopilotMessageAgentInputSchema,
	CopilotStartAgentInputSchema,
	CopilotStopAgentInputSchema,
} from "../../shared/copilot-agent.js";
import type { AgentDispatch } from "../agentDispatch.js";
import { type AgentRequestKind, postAgentRequest, requestHead } from "../agentRequest.js";
import { routerPost } from "../bridge/helpers.js";

export function copilotRequestBody(
	kind: AgentRequestKind,
	args: { agentId?: string; prompt?: string; model?: string; cwd?: string } = {},
): Record<string, unknown> {
	return {
		...requestHead(kind),
		...(args.agentId === undefined ? {} : { agentId: args.agentId }),
		...(args.prompt === undefined ? {} : { prompt: args.prompt }),
		...(kind === "start" && args.model !== undefined ? { model: args.model } : {}),
		...(kind === "start" && args.cwd !== undefined ? { cwd: args.cwd } : {}),
	};
}

export const gatewayDispatch: AgentDispatch = (body) => routerPost(agentHttpPath("copilot"), body);

function post(dispatch: AgentDispatch, body: Record<string, unknown>) {
	return postAgentRequest(COPILOT_BACKEND, dispatch, body);
}

export function registerCopilotTools(mcpServer: McpServer, dispatch: AgentDispatch = gatewayDispatch): void {
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const startSchema: any = CopilotStartAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const messageSchema: any = CopilotMessageAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const awaitSchema: any = CopilotAwaitAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const stopSchema: any = CopilotStopAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const listSchema: any = CopilotListAgentsInputSchema;

	mcpServer.registerTool(
		"copilotStartAgent",
		{
			title: `Copilot Start Agent`,
			description: `Start a Copilot Agent for a self-contained task.`,
			inputSchema: startSchema,
		},
		async (args: { prompt: string; model?: string; cwd?: string }) =>
			post(dispatch, copilotRequestBody("start", args)),
	);
	mcpServer.registerTool(
		"copilotMessageAgent",
		{
			title: `Copilot Message Agent`,
			description: `Send a follow-up to an idle Copilot Agent.`,
			inputSchema: messageSchema,
		},
		async (args: { agentId: string; prompt: string }) => post(dispatch, copilotRequestBody("message", args)),
	);
	mcpServer.registerTool(
		"copilotAwaitAgent",
		{
			title: `Copilot Await Agent`,
			description: `Wait for a Copilot Agent turn to finish.`,
			inputSchema: awaitSchema,
		},
		async (args: { agentId: string }) => post(dispatch, copilotRequestBody("await", args)),
	);
	mcpServer.registerTool(
		"copilotStopAgent",
		{ title: `Copilot Stop Agent`, description: `Stop the current Copilot Agent turn.`, inputSchema: stopSchema },
		async (args: { agentId: string }) => post(dispatch, copilotRequestBody("stop", args)),
	);
	mcpServer.registerTool(
		"copilotListAgents",
		{ title: `Copilot List Agents`, description: `List Copilot Agents and their turns.`, inputSchema: listSchema },
		async () => post(dispatch, copilotRequestBody("list")),
	);
}
