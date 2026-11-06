import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowRunner } from "../gateway/workflows/runner.js";
import { createWorkflowRunStore } from "../gateway/workflows/store.js";
import type { WorkflowRunRecord, WorkflowStartInput } from "../gateway/workflows/workflowSchemas.js";
import { openAppendJournal } from "../shared/durable-journal.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * DAY;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-runner-"));
	roots.push(dataDir);
	let now = 1_000;
	const ambient = fakeAmbient({ now: () => now, drive: "manual" });
	const store = createWorkflowRunStore(dataDir, ambient);
	const runner = createWorkflowRunner({ store, ambient });
	runner.start();
	return { dataDir, ambient, store, runner, setNow: (value: number) => (now = value) };
}

function input(operationId: string, team = "team-a"): WorkflowStartInput {
	return {
		team,
		operationId,
		resumeFrom: null,
		script: "export const meta = {};",
		args: {},
		defaultBackend: "codex",
		phases: [],
	};
}

function started(result: ReturnType<ReturnType<typeof createWorkflowRunner>["startRun"]>): WorkflowRunRecord {
	expect(result.kind).toBe("started");
	if (result.kind !== "started") throw new Error("run did not start");
	return result.run;
}

const issue = (issueOrdinal: number) => ({
	kind: "issue" as const,
	issueOrdinal,
	callHash: String(issueOrdinal).padStart(64, "0"),
	prompt: `call ${issueOrdinal}`,
	resolvedBackend: "codex" as const,
	options: {},
});

describe("workflow run persistence", () => {
	it("rolls back a line when its fsync fails", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-journal-"));
		roots.push(dataDir);
		const journalPath = path.join(dataDir, "journal.jsonl");
		const journal = openAppendJournal(journalPath);
		const sync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("sync failed");
		});
		try {
			expect(() => journal.append(issue(1))).toThrow("sync failed");
		} finally {
			sync.mockRestore();
			journal.close();
		}
		expect(fs.readFileSync(journalPath, "utf8")).toBe("");
	});

	it("drops and truncates an unterminated journal tail", () => {
		const { dataDir, ambient, store, runner } = setup();
		const run = started(runner.startRun(input("op-a")));
		runner.append(run.runId, issue(1));
		const journal = path.join(dataDir, "workflows", run.runId, "journal.jsonl");
		fs.appendFileSync(journal, '{"kind":"issue"');
		store.close();

		const restored = createWorkflowRunStore(dataDir, ambient);
		expect(restored.running().map((row) => row.runId)).toEqual([run.runId]);
		expect(restored.rows(run.runId)).toEqual([issue(1)]);
		expect(fs.readFileSync(journal, "utf8")).toBe(`${JSON.stringify(issue(1))}\n`);
	});

	it("moves a run with a corrupt complete line aside", () => {
		const { dataDir, ambient, runner } = setup();
		const run = started(runner.startRun(input("op-a")));
		runner.append(run.runId, issue(1));
		runner.append(run.runId, issue(2));
		const journal = path.join(dataDir, "workflows", run.runId, "journal.jsonl");
		const line = `${JSON.stringify(issue(1))}\n`;
		const invalidRow = { ...issue(2), status: "running" };
		fs.writeFileSync(journal, `${line}${JSON.stringify(invalidRow)}\n${JSON.stringify(issue(3))}\n`);

		const restored = createWorkflowRunStore(dataDir, ambient);
		expect(restored.all()).toEqual([]);
		const aside = path.join(dataDir, "workflows", "_aside");
		expect(fs.readdirSync(aside)).toHaveLength(1);
		expect(createWorkflowRunStore(dataDir, ambient).all()).toEqual([]);
	});

	it("replays a repeated start and enforces the session cap", () => {
		const { dataDir, ambient, store } = setup();
		const firstRunner = createWorkflowRunner({ store, ambient });
		firstRunner.start();
		const first = started(firstRunner.startRun(input("op-a")));
		store.close();
		const restoredRunner = createWorkflowRunner({ store: createWorkflowRunStore(dataDir, ambient), ambient });
		restoredRunner.start();
		const repeated = restoredRunner.startRun(input("op-a"));
		expect(repeated).toEqual({ kind: "existing", run: first });
		for (const operationId of ["op-b", "op-c", "op-d"]) {
			expect(restoredRunner.startRun(input(operationId)).kind).toBe("started");
		}
		expect(restoredRunner.startRun(input("op-e"))).toEqual({ kind: "refused", reason: "run_cap" });
	});

	it("makes every terminal state final", () => {
		const { dataDir, ambient, runner } = setup();
		for (const [index, status] of (["succeeded", "failed", "cancelled"] as const).entries()) {
			const run = started(runner.startRun(input(`op-${index}`)));
			expect(
				runner.transition(run.runId, "running", status, {
					result: null,
					failureReason: status === "failed" ? "failed" : null,
				}),
			).toBe(true);
			expect(runner.get(run.runId)?.status).toBe(status);
			if (status === "failed") expect(runner.get(run.runId)?.failureReason).toBe("failed");
			for (const next of ["succeeded", "failed", "cancelled"] as const) {
				expect(runner.transition(run.runId, status, next)).toBe(false);
			}
			expect(runner.transition(run.runId, "running", status)).toBe(false);
		}
		const terminal = runner.runs()[0]!;
		expect(runner.markNotified(terminal.runId)).toBe(true);
		expect(createWorkflowRunStore(dataDir, ambient).get(terminal.runId)?.notified).toBe(true);
	});

	it("sweeps settled runs at seven days", () => {
		const { runner, setNow } = setup();
		const old = started(runner.startRun(input("op-old")));
		expect(runner.transition(old.runId, "running", "succeeded")).toBe(true);
		setNow(1_000 + SEVEN_DAYS - 1);
		const young = started(runner.startRun(input("op-young")));
		expect(runner.transition(young.runId, "running", "succeeded")).toBe(true);
		setNow(1_000 + SEVEN_DAYS);

		expect(runner.sweep()).toBe(1);
		expect(runner.get(old.runId)).toBeNull();
		expect(runner.get(young.runId)?.status).toBe("succeeded");
	});

	it("closes admission and every runner entry", () => {
		const { runner } = setup();
		runner.stop();
		expect(runner.start()).toBe(false);
		expect(runner.startRun(input("op-a"))).toEqual({ kind: "refused", reason: "stopped" });
		expect(runner.runs()).toEqual([]);
	});
});
