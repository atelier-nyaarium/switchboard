import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWorkflowEngine,
	type WorkflowDispatchOutcome,
	type WorkflowIssuedCall,
} from "../gateway/workflows/engine.js";
import { createWorkflowRunner } from "../gateway/workflows/runner.js";
import { extractWorkflowScript, WorkflowScriptError } from "../gateway/workflows/script.js";
import { createWorkflowRunStore } from "../gateway/workflows/store.js";
import {
	createQuickJSScriptValidator,
	type WorkflowQuickJSModule,
	type WorkflowScriptValidator,
} from "../gateway/workflows/vm.js";
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

function createSetup(
	dispatch: (call: WorkflowIssuedCall, settle: PendingCall["settle"]) => void = () => {},
	scriptValidator?: WorkflowScriptValidator,
) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-engine-"));
	roots.push(dataDir);
	let clock = 1_000;
	const ambient = fakeAmbient({ now: () => clock++, drive: "manual" });
	const store = createWorkflowRunStore(dataDir, ambient);
	const runner = createWorkflowRunner({ store, ambient });
	const engine = createWorkflowEngine({
		runner,
		ambient,
		dispatch: { dispatch },
		...(scriptValidator ? { scriptValidator } : {}),
	});
	engine.start();
	return { dataDir, ambient, store, runner, engine };
}

async function setup(
	dispatch: (call: WorkflowIssuedCall, settle: PendingCall["settle"]) => void = () => {},
	scriptValidator?: WorkflowScriptValidator,
) {
	const state = createSetup(dispatch, scriptValidator);
	await state.engine.whenReady();
	return state;
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
	it("scans only the first metadata statement", () => {
		const sample = fs.readFileSync(path.join(fixtures, "workflow-example.workflow"), "utf8");
		const parsed = extractWorkflowScript(sample);
		expect(parsed.meta.name).toBe("mock-build-loop");
		expect(parsed.phases).toEqual(["Implement", "Verify"]);
		expect(() => extractWorkflowScript('export const meta = {}; return /export/.test("export");')).not.toThrow();
		expect(() => extractWorkflowScript('export const meta = {}; if (true) /export/.test("export");')).not.toThrow();
		expect(() =>
			extractWorkflowScript('export const meta = {}; if (true) {} /export/.test("export");'),
		).not.toThrow();
		expect(() =>
			extractWorkflowScript('export const meta = {}; return /[{};\\/]export/.test("export");'),
		).not.toThrow();
		const expression = "$" + '{ /}/.test("}") }';
		expect(() =>
			extractWorkflowScript(`export const meta = {}; const text = \`${expression}\`; return text;`),
		).not.toThrow();
		expect(() =>
			extractWorkflowScript(
				'export const meta = {}; const quotient = 12 / 2 / /export/.test("export"); return quotient;',
			),
		).not.toThrow();
		expect(() => extractWorkflowScript('export const meta = {}; return "import x from y";')).not.toThrow();
		expect(() => extractWorkflowScript("export const meta = makeMeta();")).toThrow(/JSON literal/);
		expect(() => extractWorkflowScript("const before = 1; export const meta = {};")).toThrow(/first statement/);
	});

	it("checks capacity and dedupe before compiling", async () => {
		let compiles = 0;
		const scriptValidator: WorkflowScriptValidator = {
			load: async () => {},
			ready: () => true,
			validate: () => {
				compiles += 1;
			},
			stop: () => {},
		};
		const { engine, runner } = await setup(() => {}, scriptValidator);
		const accepted: WorkflowRunRecord[] = [];
		for (let index = 0; index < 4; index += 1) {
			const result = engine.startRun(input(`burst-${index}`, "export const meta = {}; return true;"));
			expect(result.kind).toBe("started");
			if (result.kind === "started") accepted.push(result.run);
		}
		expect(compiles).toBe(4);
		expect(engine.startRun(input("burst-4", "export const meta = {}; return true;"))).toEqual({
			kind: "refused",
			reason: "run_cap",
		});
		expect(engine.startRun(input("burst-0", "export const meta = {}; const broken = ;"))).toEqual({
			kind: "existing",
			run: accepted[0],
		});
		expect(compiles).toBe(4);
		engine.stop();
		runner.stop();
	});

	it("refuses starts while the validation module loads", async () => {
		let loaded = false;
		let resolveLoad: () => void = () => {};
		let compiles = 0;
		const scriptValidator: WorkflowScriptValidator = {
			load: () =>
				new Promise<void>((resolve) => {
					resolveLoad = () => {
						loaded = true;
						resolve();
					};
				}),
			ready: () => loaded,
			validate: () => {
				compiles += 1;
			},
			stop: () => {},
		};
		const { engine, runner } = createSetup(() => {}, scriptValidator);
		expect(engine.startRun(input("early", "export const meta = {}; return true;"))).toEqual({
			kind: "not_ready",
			retryable: true,
		});
		expect(compiles).toBe(0);
		resolveLoad();
		await engine.whenReady();
		expect(engine.startRun(input("ready", "export const meta = {}; return true;")).kind).toBe("started");
		expect(compiles).toBe(1);
		engine.stop();
		runner.stop();
	});

	it("retries a rejected validation module load after the backoff", async () => {
		let now = 1_000;
		let attempts = 0;
		const validationModule = {
			newRuntime: () => ({
				setMemoryLimit: () => {},
				setMaxStackSize: () => {},
				newContext: () => ({ evalCode: () => ({ value: { dispose: () => {} } }), dispose: () => {} }),
				dispose: () => {},
			}),
		} as unknown as WorkflowQuickJSModule;
		const scriptValidator = createQuickJSScriptValidator(() => {
			attempts += 1;
			if (attempts === 1) return Promise.reject(new Error("temporary load failure"));
			return Promise.resolve(validationModule);
		});
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-engine-retry-"));
		roots.push(dataDir);
		const ambient = fakeAmbient({ now: () => now, drive: "manual" });
		const store = createWorkflowRunStore(dataDir, ambient);
		const runner = createWorkflowRunner({ store, ambient });
		const engine = createWorkflowEngine({ runner, ambient, dispatch: { dispatch: () => {} }, scriptValidator });
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		engine.start();
		await engine.whenReady();
		const script = "export const meta = {}; return true;";
		const operation = input("retry-load", script);
		expect(engine.startRun(operation)).toEqual({ kind: "not_ready", retryable: true });
		expect(attempts).toBe(1);
		now += 1_000;
		expect(engine.startRun(operation)).toEqual({ kind: "not_ready", retryable: true });
		await engine.whenReady();
		const result = engine.startRun(operation);
		expect(result.kind).toBe("started");
		expect(attempts).toBe(2);
		expect(errorLog).toHaveBeenCalledTimes(1);
		if (result.kind === "started") {
			await waitFor(() => runner.get(result.run.runId)?.status !== "running");
			expect(runner.get(result.run.runId)?.status).toBe("succeeded");
		}
		engine.stop();
		runner.stop();
		errorLog.mockRestore();
	});

	it.each([
		["export", "export const x = 1;", "unsupported keyword: export"],
		["import", 'import x from "y";', "expecting '('"],
		["syntax", "const x = ;", "unexpected token in expression"],
	])("refuses %s syntax before committing a run", async (_name, body, message) => {
		let dispatches = 0;
		const { engine, runner } = await setup(() => {
			dispatches += 1;
		});
		const result = engine.startRun(input(`invalid-${_name}`, `export const meta = {};\n${body}`));
		expect(result.kind).toBe("invalid_script");
		if (result.kind !== "invalid_script") throw new Error("script was accepted");
		expect(result.error).toBeInstanceOf(WorkflowScriptError);
		expect(result.error.code).toBe("syntax");
		expect(result.error.message).toContain(message);
		expect(runner.runs()).toHaveLength(0);
		expect(dispatches).toBe(0);
		engine.stop();
		runner.stop();
	});

	it("runs regex, division and template bodies without scanner guesses", async () => {
		const { engine, runner } = await setup();
		const expression = "$" + '{ /}/.test("}") }';
		const script = `export const meta = {};\nif (true) /export/.test("export");\nif (true) {} /export/.test("export");\nconst escaped = /[{};\\\\/]/.test("{");\nconst quotient = 12 / 2 / /export/.test("export");\nconst template = \`value ${expression}\`;\nreturn { escaped, quotient, template };`;
		const run = started(engine.startRun(input("lexer-cases", script)));
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.status).toBe("succeeded");
		expect(runner.get(run.runId)?.result).toEqual({ escaped: true, quotient: 6, template: "value true" });
		engine.stop();
		runner.stop();
	});

	it("compiles dynamic imports but loads no module", async () => {
		let dispatches = 0;
		const { engine, runner } = await setup(() => {
			dispatches += 1;
		});
		const result = engine.startRun(input("dynamic-import", 'export const meta = {};\nawait import("x");'));
		expect(result.kind).toBe("started");
		if (result.kind !== "started") throw new Error("dynamic import did not compile");
		await waitFor(() => runner.get(result.run.runId)?.status !== "running");
		expect(runner.get(result.run.runId)?.status).toBe("failed");
		expect(dispatches).toBe(0);
		engine.stop();
		runner.stop();
	});

	it("runs the fixture through agent, schema, phase, thread and log paths", async () => {
		const pending: PendingCall[] = [];
		const { engine, runner } = await setup((call, settle) => {
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

	it("puts a step in its own phase, else the current one, and refuses an undeclared phase", async () => {
		const calls: PendingCall[] = [];
		const { engine, runner } = await setup((call, settle) => calls.push({ call, settle }));
		const script = `export const meta = {phases: ["Build", "Verify"]};
const first = agent("one");
phase("Build");
const second = agent("two");
const third = agent("three", {phase: "Verify"});
return await parallel([() => first, () => second, () => third]);`;
		const run = started(engine.startRun(input("phases", script)));
		await waitFor(() => calls.length === 3);
		expect(calls.map(({ call }) => call.options.phase)).toEqual([undefined, "Build", "Verify"]);
		expect(engine.phase(run.runId)).toBe("Build");
		for (const { settle } of calls) settle({ outcome: "completed", answer: "ok", reason: null });
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.status).toBe("succeeded");
		const journaled = runner.rows(run.runId).flatMap((row) => (row.kind === "issue" ? [row.options.phase] : []));
		expect(journaled).toEqual([undefined, "Build", "Verify"]);

		const bad = started(
			engine.startRun(
				input(
					"bad-phase",
					'export const meta = {phases: ["Build"]}; return await agent("x", {phase: "Nope"});',
				),
			),
		);
		await waitFor(() => runner.get(bad.runId)?.status !== "running");
		expect(runner.get(bad.runId)).toMatchObject({
			status: "failed",
			failureReason: "unknown workflow phase: Nope",
		});
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
			const { engine, runner } = await setup();
			const run = started(engine.startRun(input(operationId, `export const meta = {};\n${body}`)));
			await waitFor(() => runner.get(run.runId)?.status !== "running");
			expect(runner.get(run.runId)?.status).toBe("failed");
			expect(runner.get(run.runId)?.failureReason).not.toBe("caught");
			engine.stop();
			runner.stop();
		}
	}, 30_000);

	it("throws on wall clock and random reads", async () => {
		const { engine, runner } = await setup();
		const script = `export const meta = {};\nlet clock = false; let random = false; try { Date.now(); } catch { clock = true; } try { Math.random(); } catch { random = true; } return { clock, random };`;
		const run = started(engine.startRun(input("deterministic", script)));
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.result).toEqual({ clock: true, random: true });
		engine.stop();
		runner.stop();
	});

	it("exposes only the fixed sandbox global set", async () => {
		const { engine, runner } = await setup();
		const run = started(
			engine.startRun(
				input("globals", "export const meta = {}; return Object.getOwnPropertyNames(globalThis).sort();"),
			),
		);
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.result).toEqual([
			"AggregateError",
			"Array",
			"ArrayBuffer",
			"BigInt",
			"BigInt64Array",
			"BigUint64Array",
			"Boolean",
			"DataView",
			"Date",
			"Error",
			"EvalError",
			"Float16Array",
			"Float32Array",
			"Float64Array",
			"Function",
			"Infinity",
			"Int16Array",
			"Int32Array",
			"Int8Array",
			"InternalError",
			"Iterator",
			"JSON",
			"Map",
			"Math",
			"NaN",
			"Number",
			"Object",
			"Promise",
			"Proxy",
			"RangeError",
			"ReferenceError",
			"Reflect",
			"RegExp",
			"Set",
			"SharedArrayBuffer",
			"String",
			"Symbol",
			"SyntaxError",
			"TypeError",
			"URIError",
			"Uint16Array",
			"Uint32Array",
			"Uint8Array",
			"Uint8ClampedArray",
			"WeakMap",
			"WeakSet",
			"agent",
			"args",
			"decodeURI",
			"decodeURIComponent",
			"encodeURI",
			"encodeURIComponent",
			"escape",
			"eval",
			"globalThis",
			"isFinite",
			"isNaN",
			"log",
			"meta",
			"parallel",
			"parseFloat",
			"parseInt",
			"phase",
			"pipeline",
			"undefined",
			"unescape",
		]);
		engine.stop();
		runner.stop();
	});

	it("replays parallel answers in their settle order and keeps them on their calls", async () => {
		const firstPending: PendingCall[] = [];
		const first = await setup((call, settle) => firstPending.push({ call, settle }));
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
		const { engine, runner } = await setup((call, settle) => {
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

	it.each(["turn", "settle"] as const)(
		"fails a resume before releasing an answer when its %s copy cannot append",
		async (kind) => {
			let dispatches = 0;
			let runnerRef: ReturnType<typeof createWorkflowRunner> | undefined;
			const { engine, runner } = await setup((call, settle) => {
				dispatches += 1;
				runnerRef?.append(call.runId, {
					kind: "turn",
					issueOrdinal: call.issueOrdinal,
					turnOrdinal: 1,
					turnId: `turn-${call.issueOrdinal}`,
					backend: call.backend,
					prompt: call.prompt,
					operationId: `operation-${call.issueOrdinal}`,
					registerInstanceId: "register-1",
					agentId: "agent-1",
					target: "host",
				});
				settle({ outcome: "completed", answer: "cached answer", reason: null });
			});
			runnerRef = runner;
			const script = `export const meta = {};\nconst answer = await agent("cached step"); return answer;`;
			const source = started(engine.startRun(input("copy-source", script)));
			await waitFor(() => runner.get(source.runId)?.status !== "running");
			const append = runner.append.bind(runner);
			runner.append = (runId, row) => {
				if (runId !== source.runId && row.kind === kind) return false;
				return append(runId, row);
			};

			const resumed = started(engine.startRun(input("copy-resume", script, { resumeFrom: source.runId })));
			await waitFor(() => runner.get(resumed.runId)?.status !== "running");
			expect(runner.get(resumed.runId)).toMatchObject({
				status: "failed",
				result: null,
				failureReason: `workflow resume ${kind} copy failed`,
			});
			expect(runner.rows(resumed.runId).filter((row) => row.kind === "settle")).toEqual([]);
			expect(dispatches).toBe(1);
			engine.stop();
			runner.stop();
		},
	);

	it("fails a pending script without an unsettled agent call", async () => {
		const { engine, runner } = await setup();
		const run = started(engine.startRun(input("stalled", "export const meta = {};\nawait new Promise(() => {});")));
		await waitFor(() => runner.get(run.runId)?.status !== "running");
		expect(runner.get(run.runId)?.failureReason).toBe("script stalled");
		engine.stop();
		runner.stop();
	});

	it("rejects the 201st agent call at the host", async () => {
		const { engine, runner } = await setup((_, settle) =>
			settle({ outcome: "completed", answer: null, reason: null }),
		);
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
		const { engine, runner } = await setup((_, settle) =>
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
		const { engine, runner } = await setup(() => {
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
