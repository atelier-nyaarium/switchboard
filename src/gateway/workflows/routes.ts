import { z } from "zod";
import { AGENT_WAIT_BUDGET_MS } from "../../shared/agent-backend.js";
import type { Ambient } from "../../shared/ambient.js";
import { jsonResponse } from "../routeSchemas.js";
import type { SessionAuthority } from "../sessionAuthority.js";
import type { WorkflowEngine } from "./engine.js";
import type { WorkflowRunner } from "./runner.js";
import {
	JsonObjectSchema,
	WorkflowBackendSchema,
	type WorkflowJournalRow,
	type WorkflowRunRecord,
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
const EmptySchema = z.object({}).strict();

function stepRows(rows: readonly WorkflowJournalRow[]) {
	const issues = rows.filter((row) => row.kind === "issue");
	const settles = new Map(rows.filter((row) => row.kind === "settle").map((row) => [row.issueOrdinal, row]));
	return issues
		.map((issue) => {
			if (issue.kind !== "issue") return null;
			const settle = settles.get(issue.issueOrdinal);
			return {
				label: issue.options.label ?? String(issue.issueOrdinal),
				backend: issue.resolvedBackend,
				outcome: settle?.kind === "settle" ? settle.outcome : null,
				reason: settle?.kind === "settle" ? settle.reason : null,
			};
		})
		.filter((step) => step !== null);
}

function runAnswer(record: WorkflowRunRecord, rows: readonly WorkflowJournalRow[], phase: string | null) {
	return {
		runId: record.runId,
		status: record.status,
		result: record.result,
		failureReason: record.failureReason,
		phase,
		steps: stepRows(rows),
	};
}

export function createWorkflowRoutes(deps: {
	auth?: SessionAuthority;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
	runner: WorkflowRunner;
	engine: WorkflowEngine;
	sessionStore: { teamOf(record: import("../../shared/session-store.js").SessionRecord): string };
}) {
	function owner(req: Request) {
		const record = deps.auth?.resolveConfirmedManagedSession(req);
		return record ? { record, team: deps.sessionStore.teamOf(record) } : null;
	}

	function ownedRun(team: string, runId: string): WorkflowRunRecord | null {
		const record = deps.runner.get(runId);
		return record?.team === team ? record : null;
	}

	async function pause(ms: number): Promise<void> {
		await new Promise<void>((resolve) => deps.ambient.setTimer(resolve, ms));
	}

	async function workflowStart(req: Request, body: Record<string, unknown>): Promise<Response> {
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

	async function workflowCollect(req: Request, body: Record<string, unknown>): Promise<Response> {
		const caller = owner(req);
		if (!caller) return jsonResponse({ error: "a confirmed session token is required" }, 403);
		const parsed = RunSchema.safeParse(body);
		if (!parsed.success) return jsonResponse({ error: "Invalid workflow run id" }, 400);
		let record = ownedRun(caller.team, parsed.data.runId);
		if (!record) return jsonResponse({ error: "No workflow run for this session" }, 404);
		let remaining = AGENT_WAIT_BUDGET_MS;
		while (record.status === "running" && remaining > 0) {
			const wait = Math.min(500, remaining);
			await pause(wait);
			remaining -= wait;
			record = ownedRun(caller.team, parsed.data.runId);
			if (!record) return jsonResponse({ error: "workflow engine stopped" }, 503);
		}
		return jsonResponse(runAnswer(record, deps.runner.rows(record.runId), deps.engine.phase(record.runId)));
	}

	function workflowList(req: Request, body: Record<string, unknown>): Response {
		const caller = owner(req);
		if (!caller) return jsonResponse({ error: "a confirmed session token is required" }, 403);
		if (!EmptySchema.safeParse(body).success) return jsonResponse({ error: "Invalid workflow list request" }, 400);
		const runs = deps.runner
			.runs()
			.filter((run) => run.team === caller.team)
			.slice(-50)
			.reverse();
		return jsonResponse({
			runs: runs.map((run) => runAnswer(run, deps.runner.rows(run.runId), deps.engine.phase(run.runId))),
		});
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
