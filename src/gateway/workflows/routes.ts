import { z } from "zod";
import { jsonResponse } from "../routeSchemas.js";
import type { SessionAuthority } from "../sessionAuthority.js";
import type { WorkflowEngine } from "./engine.js";
import type { WorkflowRunner } from "./runner.js";
import { extractWorkflowScript } from "./script.js";
import {
	JsonObjectSchema,
	WorkflowBackendSchema,
	type WorkflowJournalRow,
	type WorkflowRunRecord,
	WorkflowRunStatusSchema,
} from "./workflowSchemas.js";

const StartSchema = z
	.object({
		operationId: z.string().min(1).max(128),
		script: z.string(),
		args: JsonObjectSchema.default({}),
		backend: WorkflowBackendSchema.default("codex"),
		resumeFrom: z.string().min(1).nullable().optional(),
	})
	.strict();
const RunSchema = z.object({ runId: z.string().min(1) }).strict();
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const ListSchema = z
	.object({
		limit: z.number().int().positive().max(LIST_MAX).optional(),
		status: WorkflowRunStatusSchema.optional(),
	})
	.strict();
/** Caps partial answers. */
const PARTIAL_ANSWER_BUDGET_BYTES = 256 * 1024;
const NAME_MAX = 200;

type Settle = Extract<WorkflowJournalRow, { kind: "settle" }>;

function settlesOf(rows: readonly WorkflowJournalRow[]): Map<number, Settle> {
	return new Map(rows.filter((row): row is Settle => row.kind === "settle").map((row) => [row.issueOrdinal, row]));
}

function issuesOf(rows: readonly WorkflowJournalRow[]) {
	return rows.filter((row) => row.kind === "issue");
}

function stepRows(rows: readonly WorkflowJournalRow[], withAnswers: boolean) {
	const settles = settlesOf(rows);
	let budget = PARTIAL_ANSWER_BUDGET_BYTES;
	return issuesOf(rows).map((issue) => {
		const settle = settles.get(issue.issueOrdinal);
		const step = {
			label: issue.options.label ?? String(issue.issueOrdinal),
			backend: issue.resolvedBackend,
			outcome: settle ? settle.outcome : "pending",
			reason: settle ? settle.reason : null,
		};
		if (!withAnswers || !settle || settle.answer === null) return step;
		const bytes = Buffer.byteLength(JSON.stringify(settle.answer), "utf8");
		if (bytes > budget) {
			budget = 0;
			return { ...step, answerOmitted: "over the partial answer budget" };
		}
		budget -= bytes;
		return { ...step, answer: settle.answer };
	});
}

function collectAnswer(record: WorkflowRunRecord, rows: readonly WorkflowJournalRow[], phase: string | null) {
	// A succeeded script may return null on purpose.
	const partial = record.status === "failed" || record.status === "cancelled";
	return {
		runId: record.runId,
		status: record.status,
		result: record.result,
		failureReason: record.failureReason,
		phase,
		steps: stepRows(rows, partial),
	};
}

function nameOf(script: string): string | null {
	try {
		const name = extractWorkflowScript(script).meta.name;
		return typeof name === "string" ? name.slice(0, NAME_MAX) : null;
	} catch {
		return null;
	}
}

function listRow(record: WorkflowRunRecord, rows: readonly WorkflowJournalRow[]) {
	const settles = settlesOf(rows);
	const steps: Record<string, number> = {};
	for (const issue of issuesOf(rows)) {
		const outcome = settles.get(issue.issueOrdinal)?.outcome ?? "pending";
		steps[outcome] = (steps[outcome] ?? 0) + 1;
	}
	return {
		runId: record.runId,
		name: nameOf(record.script),
		status: record.status,
		createdAt: record.createdAt,
		settledAt: record.settledAt,
		steps,
	};
}

export function createWorkflowRoutes(deps: {
	auth?: SessionAuthority;
	runner: WorkflowRunner;
	engine: WorkflowEngine;
	sessionStore: { teamOf(record: import("../../shared/session-store.js").SessionRecord): string };
	/** Withdraws collected-run notices. */
	withdraw?: (team: string, runId: string) => void;
}) {
	function owner(req: Request) {
		const record = deps.auth?.resolveConfirmedManagedSession(req);
		return record ? { record, team: deps.sessionStore.teamOf(record) } : null;
	}

	function ownedRun(team: string, runId: string): WorkflowRunRecord | null {
		const record = deps.runner.get(runId);
		return record?.team === team ? record : null;
	}

	function workflowStart(req: Request, body: Record<string, unknown>): Response {
		const caller = owner(req);
		if (!caller) return jsonResponse({ error: "a confirmed session token is required" }, 403);
		if (caller.record.spawn === "windows") {
			return jsonResponse({ error: "this session has no workflow agent execution target" }, 403);
		}
		const parsed = StartSchema.safeParse(body);
		if (!parsed.success) return jsonResponse({ error: "Invalid workflow start request" }, 400);
		const existing = deps.runner.existingStart(parsed.data.operationId);
		if (existing && existing.team !== caller.team)
			return jsonResponse({ error: "workflow operation id is already in use" }, 409);
		const result = deps.engine.startRun({
			team: caller.team,
			operationId: parsed.data.operationId,
			resumeFrom: parsed.data.resumeFrom ?? null,
			script: parsed.data.script,
			args: parsed.data.args,
			defaultBackend: parsed.data.backend,
			phases: [],
		});
		if (result.kind === "not_ready") {
			return jsonResponse({ error: "workflow engine is starting", retryable: result.retryable }, 503);
		}
		if (result.kind === "started" || result.kind === "existing") {
			return jsonResponse({
				runId: result.run.runId,
				status: result.run.status,
				existing: result.kind === "existing",
			});
		}
		return jsonResponse(
			{
				error:
					result.kind === "invalid_script"
						? result.error.message
						: result.kind === "invalid_resume"
							? result.reason
							: result.reason,
			},
			400,
		);
	}

	function workflowCollect(req: Request, body: Record<string, unknown>): Response {
		const caller = owner(req);
		if (!caller) return jsonResponse({ error: "a confirmed session token is required" }, 403);
		const parsed = RunSchema.safeParse(body);
		if (!parsed.success) return jsonResponse({ error: "Invalid workflow run id" }, 400);
		const record = ownedRun(caller.team, parsed.data.runId);
		if (!record) return jsonResponse({ error: "No workflow run for this session" }, 404);
		if (record.status !== "running" && !record.collected) {
			if (!deps.runner.markCollected(record.runId)) {
				return jsonResponse({ error: "the collected mark could not be saved; collect again" }, 503);
			}
			deps.withdraw?.(record.team, record.runId);
		}
		return jsonResponse(collectAnswer(record, deps.runner.rows(record.runId), deps.engine.phase(record.runId)));
	}

	function workflowList(req: Request, body: Record<string, unknown>): Response {
		const caller = owner(req);
		if (!caller) return jsonResponse({ error: "a confirmed session token is required" }, 403);
		const parsed = ListSchema.safeParse(body);
		if (!parsed.success) return jsonResponse({ error: "Invalid workflow list request" }, 400);
		const { limit = LIST_DEFAULT, status } = parsed.data;
		const runs = deps.runner
			.runs()
			.filter((run) => run.team === caller.team && (run.status === "running" || !run.collected))
			.filter((run) => status === undefined || run.status === status)
			.slice(-limit)
			.reverse();
		return jsonResponse({ runs: runs.map((run) => listRow(run, deps.runner.rows(run.runId))) });
	}

	function workflowStop(req: Request, body: Record<string, unknown>): Response {
		const caller = owner(req);
		if (!caller) return jsonResponse({ error: "a confirmed session token is required" }, 403);
		const parsed = RunSchema.safeParse(body);
		if (!parsed.success) return jsonResponse({ error: "Invalid workflow run id" }, 400);
		const record = ownedRun(caller.team, parsed.data.runId);
		if (!record) return jsonResponse({ error: "No workflow run for this session" }, 404);
		const stopped = record.status === "running" ? deps.engine.cancel(record.runId) : false;
		const current = deps.runner.get(record.runId) ?? record;
		return jsonResponse({ runId: current.runId, status: current.status, stopped });
	}

	return { workflowStart, workflowCollect, workflowList, workflowStop };
}
