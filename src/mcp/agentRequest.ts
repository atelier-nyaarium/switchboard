// What both agent families' tools share.

import crypto from "node:crypto";
import type { AgentBackendDescriptor } from "../shared/agent-backend.js";
import type { AgentDispatch } from "./agentDispatch.js";

////////////////////////////////
//  Interfaces & Types

export type AgentRequestKind = "start" | "message" | "await" | "stop" | "list";

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

////////////////////////////////
//  Functions & Helpers

/** Mints replayable operation IDs. */
export function requestHead(kind: AgentRequestKind): { kind: AgentRequestKind; operationId?: string } {
	return { kind, ...(kind === "list" ? {} : { operationId: crypto.randomUUID() }) };
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
