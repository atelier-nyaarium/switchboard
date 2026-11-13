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
export const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NEXT_STATUS: Record<WorkflowRunStatus, readonly WorkflowTerminalStatus[]> = {
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

/** `aged` is the 7 day rule's removal, not one asked for. */
export type WorkflowAgentRetirement = (run: Pick<WorkflowRunRecord, "runId" | "team"> & { aged?: boolean }) => boolean;

export interface WorkflowRunnerDeps {
	store: WorkflowRunStore;
	ambient: Pick<Ambient, "now" | "newId">;
	retireAgents?: WorkflowAgentRetirement;
}

export type WorkflowStartResult =
	| { kind: "started"; run: WorkflowRunRecord }
	| { kind: "existing"; run: WorkflowRunRecord }
	| { kind: "refused"; reason: "stopped" | "not_admitting" | "run_cap" | "storage" };

export type WorkflowStartCheck =
	| { kind: "ready" }
	| { kind: "refused"; reason: "stopped" | "not_admitting" | "run_cap" };

export interface WorkflowRunner {
	start(): boolean;
	checkStart(team: string): WorkflowStartCheck;
	startRun(input: unknown): WorkflowStartResult;
	existingStart(operationId: string): WorkflowRunRecord | null;
	transition(
		runId: string,
		from: WorkflowRunStatus,
		to: WorkflowTerminalStatus,
		outcome?: { result?: JsonValue; failureReason?: string | null; notified?: boolean },
	): boolean;
	markNotified(runId: string): boolean;
	/** Marks a settled run collected. */
	markCollected(runId: string): boolean;
	append(runId: string, row: WorkflowJournalRow): boolean;
	get(runId: string): WorkflowRunRecord | null;
	runs(): WorkflowRunRecord[];
	running(): WorkflowRunRecord[];
	rows(runId: string): WorkflowJournalRow[];
	sweep(): number;
	/** False until agents finish; sweep completes deletion. */
	delete(runId: string): boolean;
	stop(): void;
}

export function createWorkflowRunner(deps: WorkflowRunnerDeps): WorkflowRunner {
	const { store, ambient } = deps;
	let admitting = false;
	let stopped = false;
	const deleting = new Set<string>();
	const remove = (run: WorkflowRunRecord, aged: boolean): boolean => {
		if (deps.retireAgents?.({ runId: run.runId, team: run.team, aged }) === false) return false;
		try {
			store.remove(run.runId);
		} catch {
			// A sync that fails after removal still removed it.
			if (store.get(run.runId)) return false;
		}
		deleting.delete(run.runId);
		return true;
	};
	const checkStart = (team: string): WorkflowStartCheck => {
		if (stopped) return { kind: "refused", reason: "stopped" };
		if (!admitting) return { kind: "refused", reason: "not_admitting" };
		const runningCount = store.running().filter((record) => record.team === team).length;
		if (runningCount >= RUN_CAP_PER_SESSION) return { kind: "refused", reason: "run_cap" };
		return { kind: "ready" };
	};

	return {
		start() {
			if (stopped || admitting) return false;
			admitting = true;
			return true;
		},
		checkStart,
		startRun(input) {
			if (stopped) return { kind: "refused", reason: "stopped" };
			const parsed = WorkflowStartInputSchema.safeParse(input);
			if (!parsed.success) return { kind: "refused", reason: "storage" };
			const existing = store.byStartOperationId(parsed.data.operationId);
			if (existing) return { kind: "existing", run: existing };
			const check = checkStart(parsed.data.team);
			if (check.kind === "refused") return check;
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
				collected: false,
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
		existingStart(operationId) {
			if (stopped) return null;
			return store.byStartOperationId(operationId);
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
				notified: outcome.notified ?? current.notified,
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
		markCollected(runId) {
			if (stopped) return false;
			const current = store.get(runId);
			if (!current || current.status === "running" || current.collected) return false;
			try {
				store.write({ ...current, collected: true, notified: true });
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
				if (run.status === "running" || run.settledAt === null) continue;
				if (!deleting.has(run.runId) && now - run.settledAt < SETTLED_RETENTION_MS) continue;
				if (remove(run, !deleting.has(run.runId))) removed += 1;
			}
			return removed;
		},
		delete(runId) {
			if (stopped) return false;
			const run = store.get(runId);
			if (!run) return true;
			if (run.status === "running") return false;
			if (remove(run, false)) return true;
			deleting.add(runId);
			return false;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			admitting = false;
			store.close();
		},
	};
}
