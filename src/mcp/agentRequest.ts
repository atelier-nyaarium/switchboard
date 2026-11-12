import crypto from "node:crypto";
import { type AgentBackendDescriptor, type AgentBackendId, agentHttpPath } from "../shared/agent-backend.js";
import type { AgentServiceTier } from "../shared/agent-state.js";
import { sameFamily } from "../shared/model-family.js";
import type { AgentDispatch } from "./agentDispatch.js";
import { routerPost } from "./bridge/helpers.js";

////////////////////////////////
//  Interfaces & Types

export type AgentRequestKind = "start" | "message" | "await" | "stop" | "list";

export interface AgentRequestArgs {
	agentId?: string;
	prompt?: string;
	model?: string;
	cwd?: string;
	serviceTier?: AgentServiceTier;
	reasoningEffort?: string;
	outputSchema?: Record<string, unknown>;
	limit?: number;
}

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

////////////////////////////////
//  Functions & Helpers

export function requestHead(kind: AgentRequestKind): { kind: AgentRequestKind; operationId?: string } {
	return { kind, ...(kind === "list" ? {} : { operationId: crypto.randomUUID() }) };
}

/** Same-family defaults get priority. */
export function startDefaults(
	backend: AgentBackendDescriptor,
	args: Pick<AgentRequestArgs, "model" | "serviceTier">,
): Pick<AgentRequestArgs, "model" | "serviceTier"> {
	if (!backend.options.serviceTier || args.serviceTier !== undefined) return args;
	const model = args.model ?? backend.defaultModel;
	return sameFamily(model, backend.defaultModel) ? { model, serviceTier: "priority" } : args;
}

/** Strict schemas reject extras. */
export function agentRequestBody(
	backend: AgentBackendDescriptor,
	kind: AgentRequestKind,
	args: AgentRequestArgs = {},
): Record<string, unknown> {
	const chosen = kind === "start" ? startDefaults(backend, args) : { serviceTier: args.serviceTier };
	const turn = kind === "start" || kind === "message";
	return {
		...requestHead(kind),
		...(args.agentId === undefined ? {} : { agentId: args.agentId }),
		...(kind === "list" && args.limit !== undefined ? { limit: args.limit } : {}),
		...(args.prompt === undefined ? {} : { prompt: args.prompt }),
		...(kind === "start" && chosen.model !== undefined ? { model: chosen.model } : {}),
		...(kind === "start" && args.cwd !== undefined ? { cwd: args.cwd } : {}),
		...(turn && chosen.serviceTier !== undefined ? { serviceTier: chosen.serviceTier } : {}),
		...(kind === "start" && args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
		...(turn && args.outputSchema !== undefined ? { outputSchema: args.outputSchema } : {}),
	};
}

export function gatewayDispatch(backend: AgentBackendId): AgentDispatch {
	return (body) => routerPost(agentHttpPath(backend), body);
}

export function postAgentRequest(
	backend: AgentBackendDescriptor,
	dispatch: AgentDispatch,
	body: Record<string, unknown>,
): Promise<ToolText> {
	return dispatch(body).then(
		(result) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `${backend.displayName} request failed: ${message}` }],
				isError: true,
			};
		},
	);
}
