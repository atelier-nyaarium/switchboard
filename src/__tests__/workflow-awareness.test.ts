import { describe, expect, it } from "vitest";
import { createWorkflowAwarenessSubscriber, createWorkflowWatch } from "../gateway/workflows/workflowAwareness.js";
import type { WorkflowJournalRow, WorkflowRunRecord } from "../gateway/workflows/workflowSchemas.js";
import type { AgentProgressCounts } from "../shared/agent-counter.js";

const record: WorkflowRunRecord = {
	runId: "run-1",
	team: "owner",
	startOperationId: "op-1",
	resumeFrom: null,
	script: "",
	args: {},
	defaultBackend: "codex",
	phases: [],
	status: "running",
	result: null,
	failureReason: null,
	notified: false,
	createdAt: 0,
	settledAt: null,
};

const rows: WorkflowJournalRow[] = [
	{
		kind: "issue",
		issueOrdinal: 1,
		callHash: "a".repeat(64),
		prompt: "one",
		resolvedBackend: "codex",
		options: { label: "designer" },
	},
	{ kind: "settle", settleOrdinal: 1, issueOrdinal: 1, outcome: "invalid", answer: null, reason: "invalid JSON" },
	{
		kind: "issue",
		issueOrdinal: 2,
		callHash: "b".repeat(64),
		prompt: "two",
		resolvedBackend: "copilot",
		options: { label: "builder" },
	},
];

const counts = (
	modelTurns: number,
	toolCalls: number,
	shell: number,
	edits: number,
	reads: number,
	other: number,
	filesChanged?: number,
): AgentProgressCounts => ({
	modelTurns,
	toolCalls,
	shell,
	edits,
	reads,
	other,
	...(filesChanged === undefined ? {} : { filesChanged }),
});

describe("workflow awareness", () => {
	it("reports counts since the last ten-minute checkup and names journal failures", () => {
		let now = 100;
		let currentCounts = counts(0, 0, 0, 0, 0, 0, 0);
		let logs = ["first log"];
		const observed: string[] = [];
		const subscriber = createWorkflowAwarenessSubscriber(() => true);
		const watch = createWorkflowWatch({
			runner: {
				runs: () => [record],
				rows: () => rows,
				markNotified: () => true,
			},
			engine: { phase: () => "build", logs: () => logs },
			progressCounts: () => currentCounts,
			observe: (observations) => {
				observed.push(
					subscriber.render(
						"owner",
						observations.map(({ identity, pre, post }) => ({ identity, pre, post })),
					),
				);
			},
			now: () => now,
		});

		watch.tick();
		now += 10 * 60_000;
		currentCounts = counts(5, 6, 3, 2, 1, 0, 3);
		logs = ["first log", "latest script note"];
		watch.tick();
		expect(observed.at(-1)).toContain(
			"Since last check: 5 model turns, 6 tool calls (3 shell, 2 edits, 1 read), 3 files changed. Latest: latest script note",
		);
		expect(observed.at(-1)).toContain("Failed steps: 1; newest designer: invalid: invalid JSON.");
		expect(observed.at(-1)).toContain("Steps settled: 1; running: 1");

		now += 10 * 60_000;
		currentCounts = counts(6, 8, 4, 2, 1, 1, 3);
		logs = ["second latest"];
		watch.tick();
		expect(observed.at(-1)).toContain(
			"Since last check: 1 model turn, 2 tool calls (1 shell, 1 other). Latest: second latest",
		);
	});
});
