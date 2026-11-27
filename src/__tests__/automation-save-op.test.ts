import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeAutomations } from "../gateway/compose/composeAutomations.js";
import { holesOver } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import type { ConsoleOp } from "../shared/console-protocol.js";
import { unknown } from "../shared/expressions.js";
import { type AutomationInput, AutomationSchema, type AutomationTrigger } from "../shared/schemasAutomation.js";
import { type AutomationFunctionInput, FunctionSchema } from "../shared/schemasFunction.js";

const REGISTRY = createConsoleRegistry([]);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PLUG = "aa:bb:cc:dd:ee:01";
const hourly: AutomationTrigger = { kind: "interval", everyMin: 60 };
const event: AutomationTrigger = { kind: "event", source: "github", conditions: [] };
const lit = (value: string) => ({ kind: "literal" as const, value });

const warmUp = (steps: AutomationFunctionInput["steps"]): AutomationFunctionInput => ({
	name: "Warm up",
	params: [{ name: "room", type: "device" }],
	steps,
});
const on = {
	kind: "do",
	action: "device_set",
	args: { device: { kind: "expression", text: "room" }, verb: lit("on") },
} as const;
const pointing = (trigger: AutomationTrigger): AutomationInput => ({
	enabled: true,
	trigger,
	actions: [{ kind: "run_function", function: "warm-up", values: { room: PLUG } }],
});

function stage() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-save-op-"));
	roots.push(dir);
	let n = 0;
	const { console } = composeAutomations({
		dataDir: dir,
		newIncarnation: () => `a${++n}`,
		now: () => 1_000,
		input: () => ({ type: { type: "number", integral: false }, value: unknown("not heard") }),
		offers: () => ({ numbers: [], switches: [{ device: PLUG, name: "Lamp" }] }),
		previewEvent: async () => ({ events: [] }) as never,
		automations: {
			isHome: () => true,
			eventIssue: () => null,
			eventFields: () => ["reason"],
			entropy: (size) => crypto.randomBytes(size),
			holes: () => holesOver(REGISTRY),
			actions: {
				ready: () => true,
				switchName: (device) => (device === PLUG ? "Lamp" : null),
				deviceSet: async () => ({ word: "done" }),
				iftttTrigger: async () => ({ word: "done" }),
			},
		},
	});
	/** Wire-parsed. */
	const save = (
		id: string,
		body: AutomationInput,
		automationBase: number,
		fn?: { id: string; body: AutomationFunctionInput; base: number },
		called?: { id: string; body: AutomationFunctionInput; base: number }[],
	) =>
		console.save({
			automationId: id,
			automation: AutomationSchema.parse(body),
			automationBase,
			...(fn ? { function: { as: "edit", id: fn.id, body: FunctionSchema.parse(fn.body), base: fn.base } } : {}),
			...(called ? { called: called.map((each) => ({ ...each, body: FunctionSchema.parse(each.body) })) } : {}),
			confirmed: true,
		} satisfies Omit<Extract<ConsoleOp, { kind: "automation_save" }>, "kind">);
	return { console, save };
}

const refusalOf = (answer: ReturnType<ReturnType<typeof stage>["save"]>) => {
	if (answer.stored) return null;
	const facts = { ...answer.refusal };
	Reflect.deleteProperty(facts, "line");
	return facts;
};

describe("the automation save op", () => {
	it("answers both rows, and the list reads the same rows with every user and whether one moves", () => {
		const { console, save } = stage();
		const first = save("warm", pointing(hourly), 0, { id: "warm-up", body: warmUp([on]), base: 0 });
		const second = save("ring", pointing(event), 0);
		const chime = save(
			"clock",
			{ ...pointing(hourly), actions: [{ kind: "run_function", function: "chime" }] },
			0,
			{
				id: "chime",
				body: {
					name: "Chime",
					params: [],
					steps: [
						{
							kind: "do",
							action: "tell_assistant",
							args: { when: lit("quietly"), message: lit("At {time}") },
						},
					],
				},
				base: 0,
			},
		);
		const listed = console.list();

		expect(first).toMatchObject({
			stored: true,
			automation: { id: "warm", revision: 1 },
			function: {
				id: "warm-up",
				revision: 1,
				users: ["warm"],
				moves: false,
				reads: { names: [], eventFields: [] },
			},
		});
		expect(second).toMatchObject({ stored: true, function: { users: ["warm", "ring"], moves: true } });
		expect(chime).toMatchObject({ stored: true, function: { reads: { names: ["time"], eventFields: [] } } });
		expect(listed.functions).toEqual([second.function, chime.function]);
		expect(listed.automations.map((row) => row.id)).toEqual(["warm", "ring", "clock"]);
		expect(listed.serves.functions).toEqual({
			max: 32,
			steps: ["tell_assistant", "device_set", "ifttt_trigger"],
			statements: [
				"do",
				"if",
				"try",
				"parallel",
				"start",
				"await",
				"exit",
				"throw",
				"let",
				"wait",
				"note",
				"unparsed",
				"call",
			],
			paramTypes: ["device", "text", "number"],
			unnamed: true,
			script: true,
		});
	});

	it("saves a hole in a function's step and answers it by its record, step path and span as written, for a text and an expression", () => {
		const { console, save } = stage();
		const inText = save("warm", pointing(hourly), 0, {
			id: "warm-up",
			body: warmUp([
				on,
				{ kind: "do", action: "tell_assistant", args: { when: lit("now"), message: lit("Hi {nowhere}") } },
			]),
			base: 0,
		});
		const inExpression = save("warm", pointing(hourly), 1, {
			id: "warm-up",
			body: warmUp([{ ...on, args: { ...on.args, device: { kind: "expression", text: "nowhere" } } }]),
			base: 1,
		});
		const line = expect.any(String);

		expect([inText, inExpression].map((answer) => [answer.stored, answer.issues])).toEqual([
			[
				true,
				[
					{
						level: "error",
						record: "function",
						id: "warm-up",
						step: "1",
						param: "message",
						start: 4,
						end: 11,
						line,
					},
				],
			],
			[
				true,
				[
					{
						level: "error",
						record: "function",
						id: "warm-up",
						step: "0",
						param: "device",
						start: 0,
						end: 7,
						line,
					},
				],
			],
		]);
		expect(console.list().automations.map((row) => [row.id, row.invalid, row.errors])).toEqual([
			["warm", undefined, 1],
		]);
	});

	it("answers a stale save with facts", () => {
		const { save } = stage();
		save("warm", pointing(hourly), 0, { id: "warm-up", body: warmUp([on]), base: 0 });

		const stale = save("warm", { ...pointing(hourly), label: "Changed" }, 0);

		expect(refusalOf(stale)).toMatchObject({ code: "moved", record: "automation", revision: 1 });
	});

	it("answers a check as the save would on the same rows, with what the body reads, and writes nothing", () => {
		const { console, save } = stage();
		save("warm", pointing(hourly), 0, { id: "warm-up", body: warmUp([on]), base: 0 });
		const tellsTitle = {
			kind: "do",
			action: "tell_assistant",
			args: { when: lit("now"), message: lit("{event.title}") },
		} as const;
		const op = (
			id: string,
			body: AutomationInput,
			automationBase: number,
			fn?: { body: AutomationFunctionInput; base: number },
			confirmed = true,
		) => ({
			automationId: id,
			automation: AutomationSchema.parse(body),
			automationBase,
			...(fn
				? {
						function: {
							as: "edit" as const,
							id: "warm-up",
							body: FunctionSchema.parse(fn.body),
							base: fn.base,
						},
					}
				: {}),
			confirmed,
		});
		const cases = {
			ready: op("warm", pointing({ kind: "interval", everyMin: 30 }), 1),
			stale: op("warm", { ...pointing(hourly), label: "Changed" }, 0),
			issued: op("warm", pointing(hourly), 1, { body: warmUp([on, tellsTitle]), base: 1 }),
			confirm: op("event", pointing(event), 0, undefined, false),
			function_moved: op("warm", pointing(hourly), 1, { body: warmUp([on]), base: 7 }),
		};
		const before = console.list();

		const checked = Object.fromEntries(Object.entries(cases).map(([name, each]) => [name, console.check(each)]));
		const untouched = console.list();
		const refusing = ["stale", "confirm", "function_moved"] as const;
		const saved = Object.fromEntries(refusing.map((name) => [name, console.save(cases[name]).refusal ?? null]));
		const issued = console.save(cases.issued);

		expect(untouched).toEqual(before);
		expect(
			Object.fromEntries(Object.entries(checked).map(([name, answer]) => [name, answer.refusal?.code ?? null])),
		).toEqual({ ready: null, stale: "moved", issued: null, confirm: "confirm", function_moved: "moved" });
		expect(Object.fromEntries(refusing.map((name) => [name, checked[name]?.refusal ?? null]))).toEqual(saved);
		expect(checked.issued).toMatchObject({ ready: true, reads: { names: ["event"] } });
		expect(checked.issued?.issues?.map((issue) => [issue.record, issue.step, issue.level])).toEqual([
			["automation", undefined, "error"],
		]);
		expect(issued).toMatchObject({ stored: true, issues: checked.issued?.issues });
		expect(checked.ready).toMatchObject({ ready: true, reads: { names: [], eventFields: [] } });
		expect(checked.ready).not.toHaveProperty("issues");
	});

	it("refuses a save that only points when the function is no longer the one shown", () => {
		const { console, save } = stage();
		save("warm", pointing(hourly), 0, { id: "warm-up", body: warmUp([on]), base: 0 });
		save("warm", pointing(hourly), 1, { id: "warm-up", body: { ...warmUp([on]), name: "Renamed" }, base: 1 });
		const held = console.list().automations.find((row) => row.id === "warm")?.revision ?? 0;
		const pointer = (functionBase: number) => ({
			automationId: "warm",
			automation: AutomationSchema.parse(pointing({ kind: "interval", everyMin: 30 })),
			automationBase: held,
			functionBase,
			confirmed: true,
		});

		const shownOld = console.save(pointer(1));
		const shownNow = console.save(pointer(2));

		expect([shownOld.refusal, shownNow.stored]).toMatchObject([
			{ code: "moved", record: "function", revision: 2 },
			true,
		]);
	});

	it("names the called function an issue or a refusal sits in, and a copy's derived id only once it lands", () => {
		const { console, save } = stage();
		const holed = (message: string): AutomationFunctionInput => ({
			name: "Chime",
			params: [],
			steps: [{ kind: "do", action: "tell_assistant", args: { when: lit("now"), message: lit(message) } }],
		});
		const calling = (callee: string) => ({
			id: "warm-up",
			body: warmUp([on, { kind: "call", function: callee }]),
			base: 0,
		});
		const goneCallee = save("warm", pointing(hourly), 0, calling("bell"), [
			{ id: "bell", body: holed("Hi"), base: 3 },
		]);
		const inCallee = save("warm", pointing(hourly), 0, calling("chime"), [
			{ id: "chime", body: holed("Hi {nowhere}"), base: 0 },
		]);
		const copy = {
			automationId: "warm",
			automation: AutomationSchema.parse(pointing(hourly)),
			automationBase: 1,
			function: {
				as: "copy" as const,
				from: "warm-up",
				fromBase: 1,
				body: FunctionSchema.parse(holed("Hi {nowhere}")),
			},
			confirmed: true,
		};
		const checked = console.check(copy);
		const copied = console.save(copy);

		expect(refusalOf(goneCallee)).toEqual({ code: "gone", record: "function", id: "bell" });
		expect(inCallee.issues).toMatchObject([{ level: "error", record: "function", id: "chime", step: "0" }]);
		expect(checked.issues).toMatchObject([{ level: "error", record: "function", step: "0" }]);
		expect(checked.issues?.[0]).not.toHaveProperty("id");
		expect(copied.issues).toMatchObject([{ level: "error", record: "function", id: copied.function?.id }]);
	});

	it("writes the functions its calls reach with it, new and edited, and answers their rows", () => {
		const { console, save } = stage();
		const calls = warmUp([on, { kind: "call", function: "chime" }]);
		const chime = (message: string): AutomationFunctionInput => ({
			name: "Chime",
			params: [],
			steps: [{ kind: "do", action: "tell_assistant", args: { when: lit("quietly"), message: lit(message) } }],
		});
		const first = save("warm", pointing(hourly), 0, { id: "warm-up", body: calls, base: 0 }, [
			{ id: "chime", body: chime("At {time}"), base: 0 },
		]);
		const edited = save("warm", pointing(hourly), 1, undefined, [{ id: "chime", body: chime("Now"), base: 1 }]);
		const stale = save("warm", pointing(hourly), 1, undefined, [{ id: "chime", body: chime("Late"), base: 1 }]);
		const unreached = save("warm", pointing(hourly), 1, undefined, [{ id: "bell", body: chime("Bell"), base: 0 }]);

		expect(first).toMatchObject({
			stored: true,
			function: { id: "warm-up", users: ["warm"], callers: [], reads: { names: ["time"] } },
			called: [{ id: "chime", revision: 1, users: [], callers: ["warm-up"], moves: false }],
		});
		expect(edited).toMatchObject({ stored: true, called: [{ id: "chime", revision: 2 }] });
		expect([refusalOf(stale), refusalOf(unreached)]).toEqual([
			{ code: "moved", record: "function", id: "chime", revision: 2 },
			{ code: "invalid", record: "function", id: "bell" },
		]);
		expect(console.list().functions?.map((row) => row.id)).toEqual(["warm-up", "chime"]);
	});

	it("keeps the function it pointed at when its new function calls it", () => {
		const { console, save } = stage();
		const wraps = { ...pointing(hourly), actions: [{ kind: "run_function" as const, function: "wrapper" }] };
		const wrapper: AutomationFunctionInput = {
			name: "Wrapper",
			params: [],
			steps: [{ kind: "call", function: "warm-up", values: { room: lit(PLUG) } }],
		};
		save("warm", pointing(hourly), 0, { id: "warm-up", body: warmUp([on]), base: 0 });
		const wrapped = save("warm", wraps, 1, { id: "wrapper", body: wrapper, base: 0 });
		const listed = console.list();

		expect(wrapped.stored).toBe(true);
		expect(listed.functions?.map((row) => row.id).sort()).toEqual(["warm-up", "wrapper"]);
		expect(listed.automations.map((row) => row.invalid ?? null)).toEqual([null]);
	});

	it("saves a called function's edit that leaves another automation's run unfit as its error, and refuses one that closes a loop", () => {
		const { console, save } = stage();
		const calls = warmUp([on, { kind: "call", function: "chime" }]);
		const chime = (steps: AutomationFunctionInput["steps"]): AutomationFunctionInput => ({
			name: "Chime",
			params: [],
			steps,
		});
		const tells = (message: string) =>
			({ kind: "do", action: "tell_assistant", args: { when: lit("now"), message: lit(message) } }) as const;
		save("warm", pointing(hourly), 0, { id: "warm-up", body: calls, base: 0 }, [
			{ id: "chime", body: chime([tells("Hi")]), base: 0 },
		]);
		save("ring", pointing(event), 0);

		const loop = save("warm", pointing(hourly), 1, undefined, [
			{ id: "chime", body: chime([{ kind: "call", function: "warm-up", values: { room: lit(PLUG) } }]), base: 1 },
		]);
		const unfit = save("ring", pointing(event), 1, undefined, [
			{ id: "chime", body: chime([tells("{event.title}")]), base: 1 },
		]);

		expect([refusalOf(loop), unfit.stored, unfit.issues]).toEqual([
			{ code: "loop", record: "function", id: "warm-up" },
			true,
			undefined,
		]);
		expect(console.list().automations.map((row) => [row.id, row.errors])).toEqual([
			["warm", 1],
			["ring", undefined],
		]);
	});

	it("holds a function with no name to the one automation that runs it, until it is named", () => {
		const { console, save } = stage();
		const named = (name: string): AutomationFunctionInput => ({ ...warmUp([on]), name });
		const calling: AutomationFunctionInput = {
			name: "Caller",
			params: [],
			steps: [{ kind: "call", function: "warm-up", values: { room: lit(PLUG) } }],
		};
		const callsIt = { ...pointing(hourly), actions: [{ kind: "run_function" as const, function: "caller" }] };
		const own = save("warm", pointing(hourly), 0, { id: "warm-up", body: named(""), base: 0 });
		const second = save("ring", pointing(hourly), 0);
		const called = save("clock", callsIt, 0, { id: "caller", body: calling, base: 0 });
		const renamed = save("warm", pointing(hourly), 1, { id: "warm-up", body: named("Warm up"), base: 1 });
		const shared = save("ring", pointing(hourly), 0);
		const cleared = save("warm", pointing(hourly), 1, { id: "warm-up", body: named(""), base: 2 });

		expect([own.stored, renamed.stored, shared.stored]).toEqual([true, true, true]);
		expect(FunctionSchema.safeParse(named("  ")).success).toBe(false);
		expect([refusalOf(second), refusalOf(called), refusalOf(cleared)]).toEqual(
			Array.from({ length: 3 }, () => ({ code: "private", record: "function", id: "warm-up" })),
		);
		expect(console.list().serves.functions?.unnamed).toBe(true);
	});

	it("answers an older phone's put as before", () => {
		const { console } = stage();
		const flat = AutomationSchema.parse({
			enabled: true,
			trigger: hourly,
			actions: [{ kind: "device_set", device: PLUG, verb: "on" }],
		});
		const put = console.put("plain", flat, 0, false);

		expect(Object.keys(put).sort()).toEqual(["revision", "row", "stored"]);
		expect(put).toMatchObject({ stored: true, revision: 1, row: { id: "plain", automation: flat } });
		expect(console.list().automations).toEqual([put.row]);
	});
});
