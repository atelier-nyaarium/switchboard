import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorkflowEngine,
	type WorkflowDispatchOutcome,
	type WorkflowIssuedCall,
} from "../gateway/workflows/engine.js";
import { createWorkflowRunner } from "../gateway/workflows/runner.js";
import { extractWorkflowScript } from "../gateway/workflows/script.js";
import { createWorkflowRunStore } from "../gateway/workflows/store.js";
import type { JsonValue, WorkflowRunRecord, WorkflowStartInput } from "../gateway/workflows/workflowSchemas.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const roots: string[] = [];
const fixtures = path.join(import.meta.dirname, "fixtures");

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface PendingCall {
	call: WorkflowIssuedCall;
	settle: (outcome: WorkflowDispatchOutcome) => void;
}

function setup(dispatch: (call: WorkflowIssuedCall, settle: PendingCall["settle"]) => void = () => {}) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-engine-"));
	roots.push(dataDir);
	let clock = 1_000;
	const ambient = fakeAmbient({ now: () => clock++, drive: "manual" });
	const store = createWorkflowRunStore(dataDir, ambient);
	const runner = createWorkflowRunner({ store, ambient });
	const engine = createWorkflowEngine({ runner, ambient, dispatch: { dispatch } });
	engine.start();
	return { dataDir, ambient, store, runner, engine };
}

function input(operationId: string, script: string, options: Partial<WorkflowStartInput> = {}): WorkflowStartInput {
	return {
		team: "team-a",
		operationId,
		resumeFrom: null,
		script,
		args: {},
		defaultBackend: "codex",
		phases: [],
		...options,
	};
}

function started(result: ReturnType<ReturnType<typeof createWorkflowEngine>["startRun"]>): WorkflowRunRecord {
	expect(result.kind).toBe("started");
	if (result.kind !== "started") throw new Error("workflow did not start");
	return result.run;
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("workflow did not reach expected state");
}

describe("workflow script engine", () => {
	it("scans the checked workflow example and refuses module and non-literal shapes", () => {
		const sample = fs.readFileSync(path.join(fixtures, "workflow-example.workflow"), "utf8");
		const parsed = extractWorkflowScript(sample);
		expect(parsed.meta.name).toBe("mock-build-loop");
		expect(parsed.phases).toEqual(["Implement", "Verify"]);
		expect(() => extractWorkflowScript('export const meta = {}; import("x");')).toThrow(/imports/);
		const interpolation = "$" + '{import("x")}';
		expect(() => extractWorkflowScript(`export const meta = {}; const text = \`${interpolation}\`;`)).toThrow(
			/imports/,
		);
		expect(() => extractWorkflowScript("export const meta = makeMeta();")).toThrow(/JSON literal/);
		expect(() => extractWorkflowScript("const before = 1; export const meta = {};")).toThrow(/first statement/);
	});

	it("runs the fixture through agent, schema, phase, thread and log paths", async () => {
		const pending: PendingCall[] = [];
		const { engine, runner } = setup((call, settle) => {
			pending.push({ call, settle });
			const answer: JsonValue = call.prompt.includes("Mock tester")
				? { pass: true, version: 5, failure: null }
				: call.prompt.includes("Mock verifier")
					? { version: 5, isFive: true }
					: "Mock edit and build.";
			const threadMap = call.options.thread
				? {
						kind: "thread_map" as const,
						thread: call.options.thread,
						backend: call.backend,
						agentId: "agent-implementer",
						target: "host",
						lastIssueOrdinal: call.issueOrdinal,
					}
				: undefined;
			settle({ outcome: "completed", answer, reason: null, ...(threadMap ? { threadMap } : {}) });
		});
		const script = fs.readFileSync(path.join(fixtures, "workflow-example.workflow"), "utf8");
		const run = started(engine.startRun(input("sample", script, { args: { dir: "/tmp/project" } })));
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.status).toBe("succeeded");
		expect(runner.get(run.runId)?.result).toEqual({ ok: true, rounds: 1, version: 5 });
		expect(pending.map(({ call }) => call.backend)).toEqual(["codex", "codex", "codex"]);
		expect(runner.rows(run.runId).filter((row) => row.kind === "settle")).toHaveLength(3);
		engine.stop();
		runner.stop();
	});

	it("fails runaway and caught memory exhaustion", async () => {
		for (const [operationId, body] of [
			["loop", 'try { while (true) {} } catch (error) { return "caught"; }'],
			[
				"memory",
				'try { const values = []; while (true) values.push("x".repeat(8192)); } catch (error) { return "caught"; }',
			],
		] as const) {
			const { engine, runner } = setup();
			const run = started(engine.startRun(input(operationId, `export const meta = {};\n${body}`)));
			await waitFor(() => runner.get(run.runId)?.status !== "running");
			expect(runner.get(run.runId)?.status).toBe("failed");
			expect(runner.get(run.runId)?.failureReason).not.toBe("caught");
			engine.stop();
			runner.stop();
		}
	}, 30_000);

	it("throws on wall clock and random reads", async () => {
		const { engine, runner } = setup();
		const script = `export const meta = {};\nlet clock = false; let random = false; try { Date.now(); } catch { clock = true; } try { Math.random(); } catch { random = true; } return { clock, random };`;
		const run = started(engine.startRun(input("deterministic", script)));
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.result).toEqual({ clock: true, random: true });
		engine.stop();
		runner.stop();
	});

	it("replays parallel answers in their settle order and keeps them on their calls", async () => {
		const firstPending: PendingCall[] = [];
		const first = setup((call, settle) => firstPending.push({ call, settle }));
		const script = `export const meta = {};\nreturn await parallel([() => agent("first"), () => agent("second")]);`;
		const run = started(first.engine.startRun(input("parallel", script)));
		await waitFor(() => firstPending.length === 2);
		firstPending[1]!.settle({ outcome: "completed", answer: "second-answer", reason: null });
		await waitFor(() => first.runner.rows(run.runId).some((row) => row.kind === "settle"));
		first.engine.stop();
		first.runner.stop();

		const store = createWorkflowRunStore(first.dataDir, first.ambient);
		const runner = createWorkflowRunner({ store, ambient: first.ambient });
		const replayCalls: PendingCall[] = [];
		const engine = createWorkflowEngine({
			runner,
			ambient: first.ambient,
			dispatch: { dispatch: (call, settle) => replayCalls.push({ call, settle }) },
		});
		engine.start();
		await waitFor(() => replayCalls.length === 1);
		expect(replayCalls[0]?.call.prompt).toBe("first");
		replayCalls[0]!.settle({ outcome: "completed", answer: "first-answer", reason: null });
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.result).toEqual(["first-answer", "second-answer"]);
		engine.stop();
		runner.stop();
	});

	it("resumes the unchanged prefix and dispatches from the first changed call", async () => {
		const { engine, runner } = setup((call, settle) => {
			settle({
				outcome: "completed",
				answer: call.prompt === "prefix" ? "kept" : call.prompt === "old" ? "old" : "new",
				reason: null,
			});
		});
		const source = started(
			engine.startRun(
				input(
					"old",
					`export const meta = {};\nconst a = await agent("prefix"); const b = await agent("old"); return [a, b];`,
				),
			),
		);
		await waitFor(() => runner.get(source.runId)?.status !== "running");
		const resumed = started(
			engine.startRun(
				input(
					"new",
					`export const meta = {};\nconst a = await agent("prefix"); const b = await agent("new"); return [a, b];`,
					{
						resumeFrom: source.runId,
					},
				),
			),
		);
		await waitFor(() => runner.get(resumed.runId)?.status !== "running");
		expect(runner.get(resumed.runId)?.result).toEqual(["kept", "new"]);
		expect(runner.rows(resumed.runId).filter((row) => row.kind === "settle")).toEqual([
			expect.objectContaining({ issueOrdinal: 1, outcome: "completed", answer: "kept", reason: null }),
			expect.objectContaining({ issueOrdinal: 2, outcome: "completed", answer: "new", reason: null }),
		]);
		engine.stop();
		runner.stop();
	});

	it("fails a pending script without an unsettled agent call", async () => {
		const { engine, runner } = setup();
		const run = started(engine.startRun(input("stalled", "export const meta = {};\nawait new Promise(() => {});")));
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.failureReason).toBe("script stalled");
		engine.stop();
		runner.stop();
	});

	it("rejects the 201st agent call at the host", async () => {
		const { engine, runner } = setup((_, settle) => settle({ outcome: "completed", answer: null, reason: null }));
		const run = started(
			engine.startRun(
				input(
					"cap",
					`export const meta = {};\ntry { await Promise.all(Array.from({ length: 201 }, () => agent("call"))); return "missed"; } catch (error) { return error.message; }`,
				),
			),
		);
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.result).toBe("agent call cap exceeded");
		expect(runner.rows(run.runId).filter((row) => row.kind === "issue")).toHaveLength(200);
		engine.stop();
		runner.stop();
	}, 30_000);

	it("returns null for a failed step and journals its outcome and reason", async () => {
		const { engine, runner } = setup((_, settle) =>
			settle({ outcome: "failed", answer: null, reason: "compiler error" }),
		);
		const run = started(
			engine.startRun(input("failed-step", `export const meta = {};\nreturn await agent("plain");`)),
		);
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.result).toBeNull();
		expect(runner.rows(run.runId)).toContainEqual(
			expect.objectContaining({
				kind: "settle",
				outcome: "failed",
				answer: null,
				reason: "compiler error",
			}),
		);
		engine.stop();
		runner.stop();
	});

	it("rejects unknown agent options at the call", async () => {
		let dispatches = 0;
		const { engine, runner } = setup(() => {
			dispatches += 1;
		});
		const run = started(
			engine.startRun(
				input(
					"unknown-option",
					`export const meta = {};\ntry { await agent("plain", { detail: true }); return "missed"; } catch (error) { return error.message; }`,
				),
			),
		);
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.result).toMatch(/Unrecognized key/i);
		expect(dispatches).toBe(0);
		expect(runner.rows(run.runId).filter((row) => row.kind === "issue")).toHaveLength(0);
		engine.stop();
		runner.stop();
	});
});
