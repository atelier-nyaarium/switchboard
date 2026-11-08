import { agentHttpPath } from "../../shared/agent-backend.js";
import type { AgentDispatch } from "../agentDispatch.js";
import { type AgentRequestKind, requestHead } from "../agentRequest.js";
import { routerPost } from "../bridge/helpers.js";

export interface CopilotToolArgs {
	agentId?: string;
	prompt?: string;
	model?: string;
	cwd?: string;
	reasoningEffort?: string;
	outputSchema?: Record<string, unknown>;
	limit?: number;
}

/** Absent is OMITTED, since the gateway's schemas are strict. */
export function copilotRequestBody(kind: AgentRequestKind, args: CopilotToolArgs = {}): Record<string, unknown> {
	const turn = kind === "start" || kind === "message";
	return {
		...requestHead(kind),
		...(args.agentId === undefined ? {} : { agentId: args.agentId }),
		...(kind === "list" && args.limit !== undefined ? { limit: args.limit } : {}),
		...(args.prompt === undefined ? {} : { prompt: args.prompt }),
		...(kind === "start" && args.model !== undefined ? { model: args.model } : {}),
		...(kind === "start" && args.cwd !== undefined ? { cwd: args.cwd } : {}),
		...(kind === "start" && args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
		...(turn && args.outputSchema !== undefined ? { outputSchema: args.outputSchema } : {}),
	};
}

export const gatewayDispatch: AgentDispatch = (body) => routerPost(agentHttpPath("copilot"), body);
