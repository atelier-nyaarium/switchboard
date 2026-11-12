import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";
import type { StackAgent } from "../agentStack.js";
import type { WorkflowDispatchOutcome } from "./engine.js";
import { type JsonValue, JsonValueSchema } from "./workflowSchemas.js";

export const DECLINE_TEXT =
	/content[_ -]?filter|safety classifier|terms of service|policy violation|i (?:cannot|can't|won't) (?:help|assist|provide)|i must decline/i;
export const REJECT_TEXT =
	/unsupported (?:model|effort|reasoning|schema)|unknown (?:model|effort)|invalid (?:model|effort)|schema.{0,40}(?:unsupported|not supported|cannot use)|skill.{0,40}(?:not found|missing)/i;

export interface AgentOperation {
	operationId: string;
	kind: "start" | "message" | "stop";
	state: "requested" | "accepted" | "indeterminate";
	daemonInstanceId?: string;
	turnId?: string;
	refusal?: { code?: string; message: string };
}

export interface AgentView {
	agentId: string;
	runId?: string;
	state: string;
	activeTurnId?: string;
	target: AgentExecutionTarget;
	operations: AgentOperation[];
	turns: Array<{ id: string; state: string; finalResponse?: string; error?: string; reason?: string }>;
}

export function responseValue(text: string): JsonValue {
	try {
		return JsonValueSchema.parse(JSON.parse(text));
	} catch {
		return text;
	}
}

/** Maps shared answer outcomes. */
export function answerOutcome(answer: JsonValue | string, structured: boolean): WorkflowDispatchOutcome {
	if (typeof answer !== "string") return { outcome: "completed", answer, reason: null };
	if (!structured && DECLINE_TEXT.test(answer)) return { outcome: "declined", answer: null, reason: answer };
	return { outcome: "completed", answer: responseValue(answer), reason: null };
}

export function failureOutcome(reason: string, code?: string): WorkflowDispatchOutcome {
	return { outcome: refusalOutcome(reason, code), answer: null, reason };
}

export function refusalOutcome(
	reason: string,
	code?: string,
): Exclude<WorkflowDispatchOutcome["outcome"], "completed"> {
	if (code === "daemon_unavailable" || code === "app_server_unavailable" || code === "protocol_incompatible") {
		return "unavailable";
	}
	if (DECLINE_TEXT.test(reason)) return "declined";
	if (REJECT_TEXT.test(reason)) return "rejected";
	return "failed";
}

export function agentView(
	agent: StackAgent | undefined,
	refusal?: { code?: string; message: string },
	refusalOperationId?: string,
): AgentView | undefined {
	if (!agent) return undefined;
	return {
		agentId: agent.agentId,
		...(agent.runId ? { runId: agent.runId } : {}),
		state: agent.agentState,
		...(agent.activeTurnId ? { activeTurnId: agent.activeTurnId } : {}),
		target: agent.requestedTarget,
		operations: agent.operations.map((operation) => ({
			operationId: operation.operationId,
			kind: operation.kind,
			state: operation.state,
			...(operation.daemonInstanceId ? { daemonInstanceId: operation.daemonInstanceId } : {}),
			...(operation.turnId ? { turnId: operation.turnId } : {}),
			...(refusal && operation.operationId === refusalOperationId ? { refusal } : {}),
		})),
		turns: agent.turns.map((turn) => ({
			id: turn.id,
			state: turn.state,
			...(turn.state === "completed" ? { finalResponse: turn.finalResponse } : {}),
			...(turn.state === "failed" ? { error: turn.error } : {}),
			...(turn.state === "interrupted" && turn.reason ? { reason: turn.reason } : {}),
		})),
	};
}
