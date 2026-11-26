import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeAutomations } from "../gateway/compose/composeAutomations.js";
import { evaluateHole, fillHoles, holeIssue } from "../gateway/liveConsole/holes.js";
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
			holes: () => ({
				issue: (text, names) => holeIssue(text, names, REGISTRY),
				fill: (text, names) => fillHoles(text, names, REGISTRY),
				evaluate: (source, names) => evaluateHole(source, names, REGISTRY),
			}),
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
	) =>
		console.save({
			automationId: id,
			automation: AutomationSchema.parse(body),
			automationBase,
			...(fn ? { function: { as: "edit", id: fn.id, body: FunctionSchema.parse(fn.body), base: fn.base } } : {}),
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
		expect(listed.serves?.functions).toEqual({
			max: 32,
			steps: ["tell_assistant", "device_set", "ifttt_trigger"],
			paramTypes: ["device", "text", "number"],
		});
	});

	it("refuses a hole in a function's step by its record, step path and span as written, for a text and an expression", () => {
		const { console, save } = stage();
		const inText = save("warm", pointing(hourly), 0, {
			id: "warm-up",
			body: warmUp([
				on,
				{ kind: "do", action: "tell_assistant", args: { when: lit("now"), message: lit("Hi {nowhere}") } },
			]),
			base: 0,
		});
		const inExpression = save("warm", pointing(hourly), 0, {
			id: "warm-up",
			body: warmUp([{ ...on, args: { ...on.args, device: { kind: "expression", text: "nowhere" } } }]),
			base: 0,
		});

		expect([refusalOf(inText), refusalOf(inExpression)]).toEqual([
			{
				code: "hole",
				record: "function",
				path: "1",
				param: "message",
				start: 4,
				end: 11,
			},
			{
				code: "hole",
				record: "function",
				path: "0",
				param: "device",
				start: 0,
				end: 7,
			},
		]);
		const refusalLines = [inText, inExpression].map((answer) => (answer.stored ? null : answer.refusal?.line));
		expect(refusalLines.every((line) => typeof line === "string" && line.length > 0)).toBe(true);
		expect(console.list()).toMatchObject({ automations: [], functions: [] });
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
			unfit: op("warm", pointing(hourly), 1, { body: warmUp([on, tellsTitle]), base: 1 }),
			confirm: op("event", pointing(event), 0, undefined, false),
			function_moved: op("warm", pointing(hourly), 1, { body: warmUp([on]), base: 7 }),
		};
		const before = console.list();

		const checked = Object.fromEntries(
			Object.entries(cases).map(([name, each]) => [name, console.check(each).refusal ?? null]),
		);
		const untouched = console.list();
		const saved = Object.fromEntries(
			Object.entries(cases)
				.filter(([name]) => name !== "ready")
				.map(([name, each]) => [name, console.save(each).refusal ?? null]),
		);

		expect(untouched).toEqual(before);
		expect(
			Object.fromEntries(Object.entries(checked).map(([name, refusal]) => [name, refusal?.code ?? null])),
		).toEqual({ ready: null, stale: "moved", unfit: "unfit", confirm: "confirm", function_moved: "moved" });
		expect({ ...checked, ready: undefined }).toEqual({ ...saved, ready: undefined });
		expect(console.check(cases.unfit)).toMatchObject({ ready: false, reads: { names: ["event"] } });
		expect(console.check(cases.ready)).toMatchObject({ ready: true, reads: { names: [], eventFields: [] } });
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
