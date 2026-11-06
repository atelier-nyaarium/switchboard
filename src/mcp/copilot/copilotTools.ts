import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentHttpPath, COPILOT_BACKEND } from "../../shared/agent-backend.js";
import {
	CopilotCollectAgentInputSchema,
	CopilotListAgentsInputSchema,
	CopilotMessageAgentInputSchema,
	CopilotStartAgentInputSchema,
	CopilotStopAgentInputSchema,
} from "../../shared/copilot-agent.js";
import type { AgentDispatch } from "../agentDispatch.js";
import { type AgentRequestKind, postAgentRequest, requestHead } from "../agentRequest.js";
import { routerPost } from "../bridge/helpers.js";

export interface CopilotToolArgs {
	agentId?: string;
	prompt?: string;
	model?: string;
	cwd?: string;
	reasoningEffort?: string;
	outputSchema?: Record<string, unknown>;
}

/** Absent is OMITTED, since the gateway's schemas are strict. */
export function copilotRequestBody(kind: AgentRequestKind, args: CopilotToolArgs = {}): Record<string, unknown> {
	const turn = kind === "start" || kind === "message";
	return {
		...requestHead(kind),
		...(args.agentId === undefined ? {} : { agentId: args.agentId }),
		...(args.prompt === undefined ? {} : { prompt: args.prompt }),
		...(kind === "start" && args.model !== undefined ? { model: args.model } : {}),
		...(kind === "start" && args.cwd !== undefined ? { cwd: args.cwd } : {}),
		...(kind === "start" && args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
		...(turn && args.outputSchema !== undefined ? { outputSchema: args.outputSchema } : {}),
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
	const collectSchema: any = CopilotCollectAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const stopSchema: any = CopilotStopAgentInputSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const listSchema: any = CopilotListAgentsInputSchema;

	mcpServer.registerTool(
		"copilotStartAgent",
		{
			title: `Copilot Start Agent`,
			description: `
Start a Copilot Agent for a self-contained task. Returns once it takes the turn; a completion notice follows, then call \`copilotCollectAgent\` for the result.

\`reasoningEffort\` must be one the model offers (the gpt-6 family: none, low, medium, high, xhigh, max). \`outputSchema\` is a JSON Schema the model's answer is held to; validate the answer yourself.
`.trim(),
			inputSchema: startSchema,
		},
		async (args: CopilotToolArgs & { prompt: string }) => post(dispatch, copilotRequestBody("start", args)),
	);
	mcpServer.registerTool(
		"copilotMessageAgent",
		{
			title: `Copilot Message Agent`,
			description: `Send a follow-up to a Copilot Agent. A running turn is steered; an idle one starts a new turn. Returns once it takes the message; a completion notice follows.`,
			inputSchema: messageSchema,
		},
		async (args: CopilotToolArgs & { agentId: string; prompt: string }) =>
			post(dispatch, copilotRequestBody("message", args)),
	);
	mcpServer.registerTool(
		"copilotCollectAgent",
		{
			title: `Copilot Collect Agent`,
			description: `Return a Copilot Agent's turn outcome. Call after a completion notice. A turn still running is waited on.`,
			inputSchema: collectSchema,
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
