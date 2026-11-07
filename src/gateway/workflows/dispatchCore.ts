import type { AgentExecutionTarget } from "../../shared/agent-execution-target.js";

import type { WorkflowDispatchOutcome, WorkflowIssuedCall } from "./engine.js";
import type { WorkflowRunner } from "./runner.js";
import { threadMapsOf, type WorkflowJournalRow } from "./workflowSchemas.js";

/** Shared workflow call state. */
export interface PendingCall {
	issued: WorkflowIssuedCall;
	settle: (outcome: WorkflowDispatchOutcome) => void;
	done: boolean;
	running: boolean;
	changedBy: string | null;
	waitFor: "agent" | "catalog" | "tick" | null;
	unsubscribe?: () => void;
	lastOperationId?: string;
	lastAgentId?: string;
	lastSocket?: object;
	prompt?: string;
}

export function taskKey(call: WorkflowIssuedCall): string {
	return taskIssueKey(call.runId, call.issueOrdinal);
}

export function taskIssueKey(runId: string, issueOrdinal: number): string {
	return `${runId}:${issueOrdinal}`;
}

export function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export function familyTextError(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

export function parseTarget(raw: string | null): AgentExecutionTarget | undefined {
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as AgentExecutionTarget;
		if (value && (value.kind === "host" || value.kind === "devcontainer")) return value;
	} catch {}
	return undefined;
}

export function latestTurn(
	task: PendingCall,
	runner: WorkflowRunner,
): Extract<WorkflowJournalRow, { kind: "turn" }> | undefined {
	return runner
		.rows(task.issued.runId)
		.filter(
			(row): row is Extract<WorkflowJournalRow, { kind: "turn" }> =>
				row.kind === "turn" && row.issueOrdinal === task.issued.issueOrdinal,
		)
		.sort((left, right) => right.turnOrdinal - left.turnOrdinal)[0];
}

export function latestThreadMap(
	task: PendingCall,
	runner: WorkflowRunner,
): Extract<WorkflowJournalRow, { kind: "thread_map" }> | undefined {
	const thread = task.issued.options.thread;
	if (!thread) return undefined;
	return threadMapsOf(runner.rows(task.issued.runId))
		.filter((map) => map.thread === thread)
		.at(-1);
}

/** Settled thread mapping. */
export function threadMapRow(
	task: PendingCall,
	agentId: string,
	target: AgentExecutionTarget,
): Extract<WorkflowJournalRow, { kind: "thread_map" }> | undefined {
	const thread = task.issued.options.thread;
	if (!thread) return undefined;
	return {
		kind: "thread_map",
		thread,
		backend: task.issued.backend,
		agentId,
		target: JSON.stringify(target),
		lastIssueOrdinal: task.issued.issueOrdinal,
	};
}

export function issueSettled(runId: string, issueOrdinal: number, runner: WorkflowRunner): boolean {
	return runner.rows(runId).some((row) => row.kind === "settle" && row.issueOrdinal === issueOrdinal);
}

export function makeTurn(
	task: PendingCall,
	operationId: string | null,
	agentId: string,
	registerInstanceId: string,
	target: AgentExecutionTarget,
	prompt: string,
	runner: WorkflowRunner,
	newId: () => string,
): Extract<WorkflowJournalRow, { kind: "turn" }> {
	const rows = runner.rows(task.issued.runId);
	const turnOrdinal =
		rows.filter((entry) => entry.kind === "turn" && entry.issueOrdinal === task.issued.issueOrdinal).length + 1;
	return {
		kind: "turn",
		issueOrdinal: task.issued.issueOrdinal,
		turnOrdinal,
		turnId: newId(),
		backend: task.issued.backend,
		prompt,
		operationId,
		registerInstanceId,
		agentId,
		target: JSON.stringify(target),
	};
}

export type HostFailure = { waitFor: "tick" | "catalog" } | { outcome: WorkflowDispatchOutcome };

export function hostFailure(what: string, error: string | undefined, errorKind?: string): HostFailure {
	if (errorKind === "timeout" || /timed out|did not take|not taken/i.test(error ?? "")) return { waitFor: "tick" };
	if (errorKind === "disconnected" || /offline/i.test(error ?? "")) return { waitFor: "catalog" };
	const reason = `${what}: ${error ?? "host refused"}`;
	const outcome = /unavailable|unknown|unsupported/i.test(error ?? "") ? "unavailable" : "failed";
	return { outcome: { outcome, answer: null, reason } };
}

export function thrownHostFailure(error: unknown): HostFailure {
	return { waitFor: /timeout|timed out|not taken|did not take/i.test(familyTextError(error)) ? "tick" : "catalog" };
}

export function skillRows(runId: string, runner: WorkflowRunner): Map<string, string> {
	const byHash = new Map<string, string>();
	const byPath = new Map<string, string>();
	for (const row of runner.rows(runId)) {
		if (row.kind !== "skill_text") continue;
		if (row.text !== undefined) byHash.set(row.sha256, row.text);
		byPath.set(row.path, row.sha256);
	}
	return new Map(
		[...byPath].flatMap(([path, hash]) => {
			const text = byHash.get(hash);
			return text === undefined ? [] : [[path, text] as const];
		}),
	);
}
