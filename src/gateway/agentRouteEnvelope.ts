// The route envelope both agent families share. Result shaping stays per family.

////////////////////////////////
//  Interfaces & Types

export type AgentTransitionErrorCode =
	| "invalid_input"
	| "not_found"
	| "operation_conflict"
	| "state_conflict"
	| "target_unavailable"
	| "persistence_failed";

export type AgentFailureAnswer =
	| { kind: "request" }
	| { kind: "agent"; code: "not_found" | "daemon_unavailable"; retryable: boolean };

////////////////////////////////
//  Functions & Helpers

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function validateTimestamp(at: number): number {
	if (!Number.isSafeInteger(at) || at < 0) {
		throw new AgentTransitionError("invalid_input", "transition timestamp must be a nonnegative integer");
	}
	return at;
}

/**
 * How each transition failure is answered.
 *
 * The split is not cosmetic. An agent RESULT is a report about an agent, and the schema only lets one
 * carry an error when the agent is genuinely unavailable or recovering. A refused REQUEST says
 * nothing about the agent's health, so it answers with the request-error shape instead: routing a
 * request-level failure through the result envelope fails the envelope's own schema, and the
 * resulting throw escapes the handler's catch as a 500 instead of the intended 400.
 *
 * Keyed by the error union, so a new transition code fails the build rather than at runtime.
 */
export const AGENT_FAILURE_ANSWERS: Record<AgentTransitionErrorCode, AgentFailureAnswer> = {
	invalid_input: { kind: "request" },
	// The operation ID was reused with different input, which no retry of the same call fixes.
	operation_conflict: { kind: "request" },
	// The agent cannot take this right now. That is about the REQUEST being wrong for the moment, not
	// about the agent being broken, and the caller's remedy is to await or stop first.
	state_conflict: { kind: "request" },
	not_found: { kind: "agent", code: "not_found", retryable: false },
	target_unavailable: { kind: "agent", code: "daemon_unavailable", retryable: true },
	persistence_failed: { kind: "agent", code: "daemon_unavailable", retryable: true },
};

////////////////////////////////
//  Class

/** Answered through `AGENT_FAILURE_ANSWERS`. */
export class AgentTransitionError extends Error {
	constructor(
		readonly code: AgentTransitionErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentTransitionError";
	}
}
