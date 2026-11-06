import type { Ambient } from "../../shared/ambient.js";
import type { WorkflowRunStore } from "./store.js";
import type { JsonValue } from "./workflowSchemas.js";
import {
	type WorkflowJournalRow,
	type WorkflowRunRecord,
	type WorkflowRunStatus,
	WorkflowStartInputSchema,
	type WorkflowTerminalStatus,
} from "./workflowSchemas.js";

const RUN_CAP_PER_SESSION = 4;
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NEXT_STATUS: Record<WorkflowRunStatus, readonly WorkflowTerminalStatus[]> = {
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

export type WorkflowAgentRetirement = (run: Pick<WorkflowRunRecord, "runId" | "team">) => boolean;

export interface WorkflowRunnerDeps {
	store: WorkflowRunStore;
	ambient: Pick<Ambient, "now" | "newId">;
	retireAgents?: WorkflowAgentRetirement;
}

export type WorkflowStartResult =
	| { kind: "started"; run: WorkflowRunRecord }
	| { kind: "existing"; run: WorkflowRunRecord }
	| { kind: "refused"; reason: "stopped" | "not_admitting" | "run_cap" | "storage" };

export interface WorkflowRunner {
	start(): boolean;
	startRun(input: unknown): WorkflowStartResult;
	transition(
		runId: string,
		from: WorkflowRunStatus,
		to: WorkflowTerminalStatus,
		outcome?: { result?: JsonValue; failureReason?: string | null },
	): boolean;
	markNotified(runId: string): boolean;
	append(runId: string, row: WorkflowJournalRow): boolean;
	get(runId: string): WorkflowRunRecord | null;
	runs(): WorkflowRunRecord[];
	running(): WorkflowRunRecord[];
	rows(runId: string): WorkflowJournalRow[];
	sweep(): number;
	stop(): void;
}

export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
	const { store, ambient } = deps;
	let admitting = false;
	let stopped = false;

	return {
		start() {
			if (stopped || admitting) return false;
			admitting = true;
			return true;
		},
		startRun(input) {
			if (stopped) return { kind: "refused", reason: "stopped" };
			const parsed = WorkflowStartInputSchema.safeParse(input);
			if (!parsed.success) return { kind: "refused", reason: "storage" };
			const existing = store.byStartOperationId(parsed.data.operationId);
			if (existing) return { kind: "existing", run: existing };
			if (!admitting) return { kind: "refused", reason: "not_admitting" };
			const runningCount = store.running().filter((record) => record.team === parsed.data.team).length;
			if (runningCount >= RUN_CAP_PER_SESSION) return { kind: "refused", reason: "run_cap" };
			const record: WorkflowRunRecord = {
				runId: ambient.newId(),
				team: parsed.data.team,
				startOperationId: parsed.data.operationId,
				resumeFrom: parsed.data.resumeFrom,
				script: parsed.data.script,
				args: parsed.data.args,
				defaultBackend: parsed.data.defaultBackend,
				phases: parsed.data.phases,
				status: "running",
				result: null,
				failureReason: null,
				notified: false,
				createdAt: ambient.now(),
				settledAt: null,
			};
			try {
				store.create(record);
				return { kind: "started", run: record };
			} catch {
				return { kind: "refused", reason: "storage" };
			}
		},
		transition(runId, from, to, outcome = {}) {
			if (stopped || !NEXT_STATUS[from].includes(to) || (to === "failed" && !outcome.failureReason)) return false;
			const current = store.get(runId);
			if (!current || current.status !== from) return false;
			const next: WorkflowRunRecord = {
				...current,
				status: to,
				result: outcome.result ?? null,
				failureReason: outcome.failureReason ?? null,
				settledAt: ambient.now(),
			};
			try {
				store.write(next);
				return true;
			} catch {
				return false;
			}
		},
		markNotified(runId) {
			if (stopped) return false;
			const current = store.get(runId);
			if (!current || current.status === "running" || current.notified) return false;
			try {
				store.write({ ...current, notified: true });
				return true;
			} catch {
				return false;
			}
		},
		append(runId, row) {
			if (stopped) return false;
			return store.append(runId, row);
		},
		get(runId) {
			if (stopped) return null;
			return store.get(runId);
		},
		runs() {
			if (stopped) return [];
			return store.all();
		},
		running() {
			if (stopped) return [];
			return store.running();
		},
		rows(runId) {
			if (stopped) return [];
			return store.rows(runId);
		},
		sweep() {
			if (stopped) return 0;
			const now = ambient.now();
			let removed = store.sweepAside(now, SETTLED_RETENTION_MS);
			for (const run of store.all()) {
				if (run.status === "running" || run.settledAt === null || now - run.settledAt < SETTLED_RETENTION_MS) {
					continue;
				}
				if (deps.retireAgents?.({ runId: run.runId, team: run.team }) === false) continue;
				try {
					store.remove(run.runId);
					removed += 1;
				} catch {}
			}
			return removed;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			admitting = false;
			store.close();
		},
	};
}
