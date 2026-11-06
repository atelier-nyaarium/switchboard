import {
	type AgentProgressCounts,
	deltaAgentProgressCounts,
	emptyAgentProgressCounts,
} from "../../shared/agent-counter.js";
import { workflowNoticeLine } from "../../shared/agent-notice.js";
import type { AwarenessObservation, AwarenessSubscriber } from "../../shared/awareness-types.js";
import type { WorkflowEngine } from "./engine.js";
import type { WorkflowRunner } from "./runner.js";
import type { WorkflowJournalRow } from "./workflowSchemas.js";

const PROGRESS_MS = 10 * 60_000;

export interface WorkflowNoticeState {
	runId: string;
	status: string;
	phase: string | null;
	stepsSettled: number;
	stepsRunning: number;
	failed: number;
	newestFailure: string | null;
	logs: string[];
	counts: AgentProgressCounts;
}

export interface WorkflowWatch {
	tick(): void;
	sessionConfirmed(team: string): void;
}

function labelOf(issueOrdinal: number, rows: readonly WorkflowJournalRow[]): string {
	const issue = rows.find((row) => row.kind === "issue" && row.issueOrdinal === issueOrdinal);
	return issue?.kind === "issue" ? (issue.options.label ?? String(issueOrdinal)) : String(issueOrdinal);
}

export function createWorkflowAwarenessSubscriber(
	markNotified: (runId: string) => boolean,
): AwarenessSubscriber<WorkflowNoticeState> {
	return {
		source: "workflow",
		pushAfterMs: 0,
		act: (_team, _pre, post) => (post && post.status !== "running" ? "act_now" : "no_act"),
		push: (_team, _pre, post) => post?.status === "running",
		render: (_team, changes) =>
			changes.flatMap((change) => (change.post ? [workflowNoticeLine(change.post)] : [])).join("\n\n"),
		delivered: (_team, change) => {
			if (change.post && change.post.status !== "running") markNotified(change.identity);
		},
	};
}

export function createWorkflowWatch(deps: {
	runner: Pick<WorkflowRunner, "runs" | "rows" | "markNotified">;
	engine: Pick<WorkflowEngine, "phase" | "logs">;
	progressCounts: (runId: string) => AgentProgressCounts;
	observe: (observations: readonly AwarenessObservation<WorkflowNoticeState>[]) => void;
	now: () => number;
}): WorkflowWatch {
	const nextProgress = new Map<string, { at: number; counts: AgentProgressCounts }>();

	function snapshot(runId: string, counts = emptyAgentProgressCounts()): WorkflowNoticeState | null {
		const record = deps.runner.runs().find((candidate) => candidate.runId === runId);
		if (!record) return null;
		const rows = deps.runner.rows(runId);
		const issues = rows.filter((row) => row.kind === "issue");
		const settles = rows.filter((row) => row.kind === "settle");
		const settledIssues = new Set(settles.map((row) => row.issueOrdinal));
		const failures = settles
			.filter((row) => row.outcome !== "completed")
			.sort((left, right) => right.settleOrdinal - left.settleOrdinal);
		const newestFailure = failures[0];
		return {
			runId,
			status: record.status,
			phase: deps.engine.phase(runId),
			stepsSettled: settles.length,
			stepsRunning: issues.filter((row) => !settledIssues.has(row.issueOrdinal)).length,
			failed: failures.length,
			newestFailure: newestFailure
				? `${labelOf(newestFailure.issueOrdinal, rows)}: ${newestFailure.outcome}: ${newestFailure.reason ?? "no reason"}`
				: null,
			logs: deps.engine.logs(runId).slice(-3),
			counts,
		};
	}

	function observeTerminal(team: string): void {
		const observations: AwarenessObservation<WorkflowNoticeState>[] = [];
		for (const run of deps.runner.runs()) {
			if (run.team !== team || run.status === "running" || run.notified) continue;
			const post = snapshot(run.runId);
			if (post) observations.push({ sessionKey: team, identity: run.runId, pre: undefined, post });
		}
		if (observations.length > 0) deps.observe(observations);
	}

	return {
		tick() {
			const now = deps.now();
			const observations: AwarenessObservation<WorkflowNoticeState>[] = [];
			const present = new Set<string>();
			for (const run of deps.runner.runs()) {
				present.add(run.runId);
				if (run.status !== "running") {
					nextProgress.delete(run.runId);
					if (!run.notified) {
						const post = snapshot(run.runId);
						if (post)
							observations.push({ sessionKey: run.team, identity: run.runId, pre: undefined, post });
					}
					continue;
				}
				const progress = nextProgress.get(run.runId);
				if (!progress) {
					nextProgress.set(run.runId, { at: now + PROGRESS_MS, counts: emptyAgentProgressCounts() });
					continue;
				}
				if (progress.at > now) continue;
				const currentCounts = deps.progressCounts(run.runId);
				const counts = deltaAgentProgressCounts(currentCounts, progress.counts);
				nextProgress.set(run.runId, { at: now + PROGRESS_MS, counts: currentCounts });
				const post = snapshot(run.runId, counts);
				if (post) observations.push({ sessionKey: run.team, identity: run.runId, pre: undefined, post });
			}
			for (const runId of nextProgress.keys()) if (!present.has(runId)) nextProgress.delete(runId);
			if (observations.length > 0) deps.observe(observations);
		},
		sessionConfirmed: observeTerminal,
	};
}
