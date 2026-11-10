import { agentHttpPath } from "../../shared/agent-backend.js";
import { CODEX_DEFAULT_MODEL, CODEX_PRIORITY_SERVICE_TIER, type CodexServiceTier } from "../../shared/codex-agent.js";
import { sameFamily } from "../../shared/model-family.js";
import type { AgentDispatch } from "../agentDispatch.js";
import { type AgentRequestKind, requestHead } from "../agentRequest.js";
import { routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

/** The efficient family runs at priority unless a tier is named; a heavier model never buys it unasked. */
export function codexStartDefaults(args: { model?: string; serviceTier?: CodexServiceTier }): {
	model?: string;
	serviceTier?: CodexServiceTier;
} {
	if (args.serviceTier !== undefined) return args;
	const model = args.model ?? CODEX_DEFAULT_MODEL;
	return sameFamily(model, CODEX_DEFAULT_MODEL) ? { model, serviceTier: CODEX_PRIORITY_SERVICE_TIER } : args;
}

/** Absent is OMITTED, since the gateway's schemas are strict. */
export function codexRequestBody(
	kind: AgentRequestKind,
	args: {
		agentId?: string;
		prompt?: string;
		model?: string;
		cwd?: string;
		serviceTier?: CodexServiceTier;
		outputSchema?: Record<string, unknown>;
		limit?: number;
	} = {},
): Record<string, unknown> {
	const chosen = kind === "start" ? codexStartDefaults(args) : { serviceTier: args.serviceTier };
	const turn = kind === "start" || kind === "message";
	return {
		...requestHead(kind),
		...(args.agentId === undefined ? {} : { agentId: args.agentId }),
		...(kind === "list" && args.limit === undefined ? {} : kind === "list" ? { limit: args.limit } : {}),
		...(args.prompt === undefined ? {} : { prompt: args.prompt }),
		...(kind === "start" && chosen.model !== undefined ? { model: chosen.model } : {}),
		...(kind === "start" && args.cwd !== undefined ? { cwd: args.cwd } : {}),
		...(turn && chosen.serviceTier !== undefined ? { serviceTier: chosen.serviceTier } : {}),
		...(turn && args.outputSchema !== undefined ? { outputSchema: args.outputSchema } : {}),
	};
}

export const gatewayDispatch: AgentDispatch = (body) => routerPost(agentHttpPath("codex"), body);
