import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeAutomations } from "../gateway/compose/composeAutomations.js";
import type { Attempt } from "../gateway/computed/automationRunner.js";
import { NEWER_SET, STEP_UNFIT, VALUE_UNREAD } from "../gateway/computed/automations.js";
import { FUNCTION_GONE, FUNCTION_UNREAD } from "../gateway/computed/automationValidity.js";
import { evaluateHole, fillHoles, holeIssue } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { unknown } from "../shared/expressions.js";
import { type AutomationInput, AutomationSchema, type AutomationTrigger } from "../shared/schemasAutomation.js";
import { type AutomationFunctionInput, FunctionSchema, type StepArg } from "../shared/schemasFunction.js";

const REGISTRY = createConsoleRegistry([]);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PLUG = "aa:bb:cc:dd:ee:01";
const FAN = "aa:bb:cc:dd:ee:02";
const HOUR = 3_600_000;
const hourly: AutomationTrigger = { kind: "interval", everyMin: 60 };
const event: AutomationTrigger = { kind: "event", source: "github", conditions: [] };

const lit = (value: string | number) => ({ kind: "literal" as const, value });
const expr = (text: string) => ({ kind: "expression" as const, text });
const turn = (verb: string, device: StepArg = expr("room")) =>
	({ kind: "do", action: "device_set", args: { device, verb: lit(verb) } }) as const;
const ifttt = (name: string, value1?: string) =>
	({
		kind: "do",
		action: "ifttt_trigger",
		args: { event: lit(name), ...(value1 === undefined ? {} : { value1: lit(value1) }) },
	}) as const;
const room = [{ name: "room", type: "device" as const }];

const pointing = (
	trigger: AutomationTrigger,
	call: { keepTryingMin?: number; coolDownSec?: number } = {},
): AutomationInput => ({
	enabled: true,
	trigger,
	actions: [{ kind: "run_function", function: "warm-up", values: { room: PLUG }, ...call }],
});

function world() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "function-runs-"));
	roots.push(dir);
	let clock = 1_000_000;
	let n = 0;
	const effects: string[] = [];
	let answer: (effect: string) => Attempt = () => ({ word: "done" });
	const open = () =>
		composeAutomations({
			dataDir: dir,
			newIncarnation: () => `a${++n}`,
			now: () => clock,
			input: () => ({ type: { type: "number", integral: false }, value: unknown("not heard") }),
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
					switchName: (device) => (device === PLUG ? "Lamp" : device === FAN ? "Fan" : null),
					deviceSet: async (device, verb) => {
						effects.push(`${device}:${verb}`);
						return answer(`${device}:${verb}`);
					},
					iftttTrigger: async ({ event, value1 }) => {
						effects.push(value1 === undefined ? `ifttt:${event}` : `ifttt:${event}:${value1}`);
						return answer(`ifttt:${event}`);
					},
				},
			},
			offers: () => ({ numbers: [], switches: [] }),
			previewEvent: async () => ({ preview: { matched: 0, of: 0, matches: [] }, names: null }),
		});
	let stage = open();
	let automations = stage.automations;
	const save = (
		body: AutomationInput,
		steps: AutomationFunctionInput["steps"],
		bases: { automation: number; function: number } = { automation: 0, function: 0 },
		params: AutomationFunctionInput["params"] = room,
	) =>
		automations.save({
			id: "warm",
			body,
			base: bases.automation,
			function: {
				as: "edit",
				id: "warm-up",
				body: { name: "Warm up", params, steps },
				base: bases.function,
			},
			confirmed: true,
		});
	const later = async (ms: number) => {
		clock += ms;
		automations.tick();
		await automations.settled();
	};
	const rows = () => automations.log().map((row) => [row.action, row.outcome, row.reason]);
	/** Rewrite records, restart. */
	const restartWith = (edit: (rows: { id: string; kind: string; body: unknown }[]) => object[]) => {
		const file = path.join(dir, "automations.json");
		fs.writeFileSync(file, JSON.stringify(edit(JSON.parse(fs.readFileSync(file, "utf8")))));
		stage = open();
		automations = stage.automations;
	};
	return {
		dir,
		effects,
		save,
		later,
		rows,
		restartWith,
		get console() {
			return stage.console;
		},
		get automations() {
			return automations;
		},
		answer: (next: (effect: string) => Attempt) => {
			answer = next;
		},
		at: () => clock,
	};
}

const unreachable = (): Attempt => ({ word: "unreachable" });

describe("a run through a function", () => {
	it("fills a declared number through a hole in the fire and preview", async () => {
		const w = world();
		const params = [{ name: "count", type: "number" as const }];
		const body: AutomationInput = {
			enabled: true,
			trigger: event,
			actions: [{ kind: "run_function", function: "warm-up", values: { count: 42 } }],
		};
		w.save(body, [ifttt("bell", "Count {count}")], undefined, params);

		w.automations.fireEvents([{ automation: "warm", key: "number", names: {} }], w.at());
		await w.automations.settled();
		const preview = await w.console.preview(event, "Count {count}", params, { count: 42 });

		expect([w.effects, preview.filled]).toEqual([["ifttt:bell:Count 42"], "Count 42"]);
	});

	it("runs its steps in order, each reading its values when it starts", async () => {
		const w = world();
		w.save(pointing(hourly), [turn("on"), ifttt("bell", "{room} is on")]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:on`, "ifttt:bell:Lamp is on"]);
		expect(w.rows()).toEqual([
			["device_set", "ran", undefined],
			["ifttt_trigger", "ran", undefined],
		]);
	});

	it("ends a step whose values cannot be read or do not fit, and carries on", async () => {
		const w = world();
		const sideways = {
			kind: "do",
			action: "device_set",
			args: { device: lit(PLUG), verb: expr('"sideways"') },
		} as const;
		w.save(pointing(hourly), [turn("on", expr("room.missing")), sideways, turn("off")]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:off`]);
		expect(w.rows()).toEqual([
			["device_set", "refused", VALUE_UNREAD],
			["device_set", "refused", STEP_UNFIT],
			["device_set", "ran", undefined],
		]);
	});

	it("tells through the outbox with its message filled, the owner's words beside it", async () => {
		const w = world();
		w.save(pointing(hourly), [
			{ kind: "do", action: "tell_assistant", args: { when: lit("now"), message: lit("Warm {room}") } },
		]);
		await w.later(HOUR);

		expect(w.automations.outbox.events()).toMatchObject([
			{ when: "now", fields: { message: "Warm Lamp", note: "Warm {room}" } },
		]);
		expect(w.rows()).toEqual([["tell_assistant", "ran", undefined]]);
	});

	it("ends a step at its call's window, where the default keeps trying", async () => {
		const short = world();
		const long = world();
		short.save(pointing(hourly, { keepTryingMin: 1 }), [turn("on")]);
		long.save(pointing(hourly), [turn("on")]);
		for (const w of [short, long]) {
			w.answer(unreachable);
			await w.later(HOUR);
			await w.later(61_000);
		}

		expect([short.effects.length, long.effects.length]).toEqual([1, 2]);
		expect(short.rows()).toEqual([["device_set", "refused", "it could not be reached"]]);
		expect(long.rows()).toEqual([]);
	});

	it("starts a waiting run in the pump where the run before it ended at its turn", async () => {
		const w = world();
		w.save(pointing({ kind: "interval", everyMin: 1 }, { keepTryingMin: 1 }), [turn("on")]);
		w.answer(unreachable);
		await w.later(60_000);
		await w.later(60_000);

		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`]);
		expect(w.rows()).toEqual([["device_set", "refused", "it could not be reached"]]);
	});

	it("counts the call's cool-down from admission, so a failing run still cools down", async () => {
		const w = world();
		w.save(pointing(event, { coolDownSec: 60 }), [ifttt("bell")]);
		w.answer(() => ({ word: "refused" }));
		for (const [key, after] of [
			["one", 0],
			["two", 10_000],
		] as const) {
			w.automations.fireEvents([{ automation: "warm", key, names: {} }], w.at() + after);
			await w.automations.settled();
		}

		expect(w.effects).toEqual(["ifttt:bell"]);
		expect(w.rows().map(([, outcome, reason]) => [outcome, reason])).toContainEqual([
			"suppressed",
			"inside its cool-down",
		]);
	});

	it("starts a revived automation's cool-down afresh", async () => {
		const w = world();
		w.save(pointing(event, { coolDownSec: 60 }), [ifttt("bell")]);
		const ring = async (key: string, after: number) => {
			w.automations.fireEvents([{ automation: "warm", key, names: {} }], w.at() + after);
			await w.automations.settled();
		};
		await ring("one", 0);
		w.automations.write({ kind: "carry", rows: [], functions: [] });
		w.automations.write({
			kind: "carry",
			rows: [{ id: "warm", automation: AutomationSchema.parse(pointing(event, { coolDownSec: 60 })) }],
			functions: [
				{
					id: "warm-up",
					function: FunctionSchema.parse({ name: "Warm up", params: room, steps: [ifttt("bell")] }),
				},
			],
		});
		await ring("two", 10_000);

		expect(w.effects).toEqual(["ifttt:bell", "ifttt:bell"]);
	});

	it("admits nothing inside the call's cool-down, logging it once until a run comes between", async () => {
		const w = world();
		w.save(pointing(event, { coolDownSec: 60 }), [ifttt("bell")]);
		const fire = async (key: string, after: number) => {
			w.automations.fireEvents([{ automation: "warm", key, names: {} }], w.at() + after);
			await w.automations.settled();
		};
		await fire("one", 0);
		await fire("two", 10_000);
		await fire("three", 20_000);
		await fire("four", 70_000);

		expect(w.effects).toEqual(["ifttt:bell", "ifttt:bell"]);
		expect(w.rows()).toEqual([
			["ifttt_trigger", "ran", undefined],
			[undefined, "suppressed", "inside its cool-down"],
			["ifttt_trigger", "ran", undefined],
		]);
	});
});

describe("a newer setting of a switch", () => {
	const plugOff: AutomationInput = {
		enabled: true,
		trigger: { kind: "interval", everyMin: 1 },
		actions: [{ kind: "device_set", device: PLUG, verb: "off" }],
	};
	/** The fan keeps failing while a newer Off of the plug lands. */
	const raced = async (w: ReturnType<typeof world>) => {
		w.answer((effect) => (effect.startsWith(FAN) ? { word: "unreachable" } : { word: "done" }));
		await w.later(HOUR);
		w.automations.ownerPut("off", plugOff, 0, true);
		await w.later(60_000);
		w.answer(() => ({ word: "done" }));
		await w.later(10_000);
	};

	it("ends a function's later step on that switch, as it ends a flat one's", async () => {
		const inFunction = world();
		inFunction.save(
			{
				enabled: true,
				trigger: hourly,
				actions: [{ kind: "run_function", function: "warm-up", values: { room: FAN }, keepTryingMin: 60 }],
			},
			[turn("on"), turn("on", lit(PLUG))],
		);
		const flat = world();
		flat.automations.ownerPut(
			"warm",
			{
				enabled: true,
				trigger: hourly,
				actions: [
					{ kind: "device_set", device: FAN, verb: "on" },
					{ kind: "device_set", device: PLUG, verb: "on" },
				],
			},
			0,
			true,
		);
		for (const w of [inFunction, flat]) await raced(w);

		for (const w of [inFunction, flat]) {
			expect(w.effects.filter((effect) => effect.startsWith(PLUG))).toEqual([`${PLUG}:off`]);
			expect(w.rows()).toContainEqual(["device_set", "refused", NEWER_SET]);
		}
	});
});

describe("a run and an edit of its function", () => {
	it("finishes a started run on the function it entered, and a later run reads the edit", async () => {
		const w = world();
		w.save(pointing(hourly), [turn("on"), ifttt("bell")]);
		w.answer(unreachable);
		await w.later(HOUR);
		const edited = w.save(pointing(hourly), [ifttt("gong")], { automation: 1, function: 1 });
		w.answer(() => ({ word: "done" }));
		await w.later(10_000);
		await w.later(HOUR);

		expect(edited.stored).toBe(true);
		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`, "ifttt:bell", "ifttt:gong"]);
	});

	for (const [lost, reason, edit] of [
		[
			"unreadable",
			FUNCTION_UNREAD,
			(row: { kind: string; body: unknown }) =>
				row.kind === "function"
					? [{ ...row, body: { ...(row.body as object), steps: [{ kind: "loop" }] } }]
					: [row],
		],
		["gone", FUNCTION_GONE, (row: { kind: string }) => (row.kind === "function" ? [] : [row])],
	] as const) {
		it(`ends a waiting run's call refused when its function is ${lost} at entry, after the started run finishes on what it pinned`, async () => {
			const w = world();
			w.save(pointing({ kind: "interval", everyMin: 15 }, { keepTryingMin: 60 }), [turn("on")]);
			w.answer(unreachable);
			await w.later(HOUR / 4);
			await w.later(HOUR / 4);
			const before = w.effects.length;
			w.restartWith((rows) => rows.flatMap((row) => edit(row)));
			w.answer(() => ({ word: "done" }));
			await w.later(10_000);

			expect(w.effects.slice(before)).toEqual([`${PLUG}:on`]);
			expect(w.rows().slice(-2)).toEqual([
				["device_set", "ran", undefined],
				["run_function", "refused", reason],
			]);
		});
	}
});

describe("a restart", () => {
	it("resumes a flat run from a state with no function versions", async () => {
		const w = world();
		w.automations.ownerPut(
			"flat",
			{ enabled: true, trigger: hourly, actions: [{ kind: "device_set", device: PLUG, verb: "on" }] },
			0,
		);
		w.answer(unreachable);
		await w.later(HOUR);
		const file = path.join(w.dir, "automation-state.json");
		const { functionVersions: _dropped, ...older } = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify(older));
		w.restartWith((rows) => rows);
		w.answer(() => ({ word: "done" }));
		await w.later(10_000);

		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`]);
		expect(w.rows()).toEqual([["device_set", "ran", undefined]]);
	});
});
