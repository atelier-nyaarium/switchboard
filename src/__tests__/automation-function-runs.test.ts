import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeAutomations } from "../gateway/compose/composeAutomations.js";
import type { Fire } from "../gateway/computed/automationFires.js";
import { type LastRuns, recorded } from "../gateway/computed/automationLastRun.js";
import { QUEUE_FULL, QUEUE_MAX_EVENTS } from "../gateway/computed/automationOutbox.js";
import { CALL_FAILED, SCRIPT_ERRORS, STEP_ERRORS, TOO_MANY_BESIDE } from "../gateway/computed/automationPass.js";
import type { Attempt } from "../gateway/computed/automationRunner.js";
import {
	type AutomationHoles,
	CONDITION_UNREAD,
	NEWER_SET,
	NOT_TRUE_OR_FALSE,
	STEP_UNFIT,
	THROWN,
	TOO_MANY_CALLS,
	VALUE_TOO_LARGE,
	VALUE_UNREAD,
} from "../gateway/computed/automations.js";
import { NO_TASK, WAITS_FOREVER } from "../gateway/computed/automationTasks.js";
import {
	CALL_LOOPS,
	EXIT_BESIDE,
	FUNCTION_GONE,
	FUNCTION_UNREAD,
	NAME_TAKEN,
	NO_SWITCH,
	TOO_WIDE,
	UNPARSED_ALONE,
} from "../gateway/computed/automationValidity.js";
import { holesOver } from "../gateway/liveConsole/holes.js";
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
/** A text whose holes fill. */
/** A quoted string with a hole: an expression. */
const filled = (body: string) => ({ kind: "expression" as const, text: `"${body}"` });
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
	settings: { keepTryingMin?: number; coolDownSec?: number } = {},
): AutomationInput => ({
	enabled: true,
	trigger:
		trigger.kind === "event" && settings.coolDownSec !== undefined
			? { ...trigger, coolDownSec: settings.coolDownSec }
			: trigger,
	actions: [{ kind: "run_function", function: "warm-up", values: { room: PLUG } }],
	...(settings.keepTryingMin === undefined ? {} : { keepTryingMin: settings.keepTryingMin }),
});

/** `stored`: the state file it opens over. */
function world(stored?: object) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "function-runs-"));
	roots.push(dir);
	if (stored) fs.writeFileSync(path.join(dir, "automation-state.json"), JSON.stringify(stored));
	let clock = 1_000_000;
	let n = 0;
	const effects: string[] = [];
	const unplugged = new Set<string>();
	let answer: (effect: string) => Attempt = () => ({ word: "done" });
	/** Attempts wait here before they answer. */
	let gate: Promise<void> = Promise.resolve();
	let evaluating: AutomationHoles["evaluate"] = holesOver(REGISTRY).evaluate;
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
				holes: () => ({ ...holesOver(REGISTRY), evaluate: (source, names) => evaluating(source, names) }),
				actions: {
					ready: () => true,
					switchName: (device) =>
						unplugged.has(device) ? null : device === PLUG ? "Lamp" : device === FAN ? "Fan" : null,
					deviceSet: async (device, verb) => {
						effects.push(`${device}:${verb}`);
						await gate;
						return answer(`${device}:${verb}`);
					},
					iftttTrigger: async ({ event, value1 }) => {
						effects.push(value1 === undefined ? `ifttt:${event}` : `ifttt:${event}:${value1}`);
						await gate;
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
	/** As the console saves it, issues included. */
	const saveOp = (
		body: AutomationInput,
		steps: AutomationFunctionInput["steps"],
		bases: { automation: number; function: number } = { automation: 0, function: 0 },
		params: AutomationFunctionInput["params"] = room,
	) =>
		automations.saveOp({
			automationId: "warm",
			automation: AutomationSchema.parse(body),
			automationBase: bases.automation,
			function: {
				as: "edit",
				id: "warm-up",
				body: FunctionSchema.parse({ name: "Warm up", params, steps }),
				base: bases.function,
			},
			confirmed: true,
		});
	const later = async (ms: number) => {
		clock += ms;
		automations.tick();
		await automations.settled();
	};
	/** Moves the clock and lets what can start, start; never waits for an attempt. */
	const advance = async (ms: number) => {
		clock += ms;
		automations.tick();
		for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
	};
	/** Every attempt from now waits until released. */
	const holdEffects = () => {
		let release = () => {};
		gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		return () => {
			release();
			gate = Promise.resolve();
		};
	};
	const rows = () => automations.log().map((row) => [row.action, row.outcome, row.reason]);
	const where = () => automations.log().map((row) => [row.step, row.function]);
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
		saveOp,
		later,
		advance,
		holdEffects,
		rows,
		where,
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
		unplug: (device: string) => unplugged.add(device),
		/** Holds every read until released. */
		holdReads: () => {
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const read = evaluating;
			evaluating = async (source, names) => {
				await gate;
				return read(source, names);
			};
			return release;
		},
		state: () => JSON.parse(fs.readFileSync(path.join(dir, "automation-state.json"), "utf8")),
		/** One starts; one waits. */
		queueTwo: async () => {
			answer = unreachable;
			for (const key of ["one", "two"]) {
				automations.fireEvents([{ automation: "warm", key, names: {} }], clock);
				await automations.settled();
			}
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
		const preview = await w.console.preview({
			trigger: event,
			text: "Count {count}",
			params,
			values: { count: 42 },
		});

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
		const unread = turn("on", expr("room.missing"));
		w.save(pointing(hourly), [unread, unread, sideways, turn("off")]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:off`]);
		expect(w.rows()).toEqual([
			["device_set", "refused", VALUE_UNREAD],
			["device_set", "refused", VALUE_UNREAD],
			["device_set", "refused", STEP_UNFIT],
			["device_set", "ran", undefined],
			["run_function", "refused", CALL_FAILED],
		]);
		expect(w.where()).toEqual(["0.0", "0.1", "0.2", "0.3", "0"].map((step) => [step, "warm-up"]));
	});

	it("fails a flat action whose switch went at its turn, and runs the rest", async () => {
		const w = world();
		const flat: AutomationInput = {
			enabled: true,
			trigger: hourly,
			actions: [
				{ kind: "device_set", device: FAN, verb: "on" },
				{ kind: "device_set", device: PLUG, verb: "on" },
			],
		};
		w.automations.save({ id: "flat", body: flat, base: 0, confirmed: true });
		w.unplug(FAN);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:on`]);
		expect(w.rows()).toEqual([
			["device_set", "refused", STEP_ERRORS],
			["device_set", "ran", undefined],
		]);
	});

	it("saves an unsound body armed, and every run fails at the broken step after the steps before it ran", async () => {
		const w = world();
		const written = w.save(pointing(event), [turn("on", lit("aa:bb:cc:dd:ee:99"))]);
		w.save(pointing(event, { keepTryingMin: 60 }), [turn("on", lit(PLUG)), turn("on", lit(FAN))], {
			automation: 1,
			function: 1,
		});
		await w.queueTwo();
		w.unplug(FAN);
		const read = w.automations.rows().map((row) => [row.invalid, row.errors]);
		w.answer(() => ({ word: "done" }));
		await w.later(60_000);
		await w.later(60_000);

		expect([written.stored, read]).toEqual([true, [[undefined, 1]]]);
		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`, `${PLUG}:on`]);
		expect(w.rows()).toEqual([
			["device_set", "ran", undefined],
			["device_set", "refused", STEP_ERRORS],
			["run_function", "refused", CALL_FAILED],
			["device_set", "ran", undefined],
		]);
		expect(
			w.automations.lastRun("warm")?.steps.map(({ path, outcome, reason }) => [path, outcome, reason]),
		).toEqual([
			["0", "refused", STEP_ERRORS],
			["0.0", "ran", undefined],
			["0.1", "refused", STEP_ERRORS],
		]);
	});

	it("refuses a call at entry whose bound device went, after the run before it read its own", async () => {
		const w = world();
		w.save(pointing(event, { keepTryingMin: 60 }), [turn("on")]);
		await w.queueTwo();
		w.unplug(PLUG);
		w.answer(() => ({ word: "done" }));
		await w.later(60_000);

		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`]);
		expect(w.rows()).toEqual([
			["device_set", "ran", undefined],
			["run_function", "refused", NO_SWITCH],
		]);
		expect(w.where().at(-1)).toEqual(["0", "warm-up"]);
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

	it("tells twice from one function reached at two call sites", async () => {
		const w = world();
		const call = { kind: "call" as const, function: "chime" };
		w.automations.save({
			id: "warm",
			body: pointing(hourly),
			base: 0,
			function: {
				as: "edit",
				id: "warm-up",
				body: { name: "Warm up", params: room, steps: [call, call] },
				base: 0,
			},
			called: [
				{
					id: "chime",
					body: {
						name: "Chime",
						params: [],
						steps: [{ kind: "do", action: "tell_assistant", args: { when: lit("quietly") } }],
					},
					base: 0,
				},
			],
			confirmed: true,
		});
		await w.later(HOUR);

		const told = w.automations.outbox.events();
		expect(told).toHaveLength(2);
		expect(new Set(told.map((event) => event.id)).size).toBe(2);
	});

	it("logs a tell step held for a full outbox under that step, and a deleted automation's rows go with it", async () => {
		const urgent = Array.from({ length: QUEUE_MAX_EVENTS }, (_, n) => ({
			member: `old:${n}`,
			at: 500 + n,
			body: { title: "Old", fields: { value: "x" }, when: "now" },
		}));
		const w = world({ automations: {}, queue: { lastAt: 999, events: urgent }, log: [] });
		w.save(pointing(hourly), [{ kind: "do", action: "tell_assistant", args: { when: lit("now") } }]);
		await w.later(HOUR);
		const held = [w.rows(), w.where()];
		w.automations.ownerRemove("warm", 1);
		await w.automations.settled();

		expect(held).toEqual([[["tell_assistant", "refused", QUEUE_FULL]], [["0.0", "warm-up"]]]);
		expect(w.rows()).toEqual([]);
	});

	it("ends a step at its automation's window, where the default keeps trying", async () => {
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
		expect(short.rows()).toEqual([
			["device_set", "refused", "it could not be reached"],
			["run_function", "refused", CALL_FAILED],
		]);
		expect(long.rows()).toEqual([]);
	});

	it("ends a step of an automation's own at its window too", async () => {
		const flat = (keepTryingMin?: number): AutomationInput => ({
			enabled: true,
			trigger: hourly,
			actions: [{ kind: "device_set", device: PLUG, verb: "on" }],
			...(keepTryingMin === undefined ? {} : { keepTryingMin }),
		});
		const short = world();
		const long = world();
		short.automations.ownerPut("flat", flat(1), 0, true);
		long.automations.ownerPut("flat", flat(), 0, true);
		for (const w of [short, long]) {
			w.answer(unreachable);
			await w.later(HOUR);
			await w.later(61_000);
		}

		expect([short.effects.length, long.effects.length]).toEqual([1, 2]);
		expect([short, long].map((w) => w.automations.log().map((row) => row.outcome))).toEqual([["refused"], []]);
	});

	it("says an event automation is cooling after a match the lane alone tells, and logs the matches inside it once", async () => {
		const w = world();
		const cooled: AutomationInput = {
			enabled: true,
			trigger: { kind: "event", source: "github", conditions: [], coolDownSec: 60 },
			actions: [{ kind: "tell_assistant", when: "now" }],
		};
		const cooling = () => w.automations.eventsOf("github").map((held) => held.cooling);
		const match = (key: string) => w.automations.fireEvents([{ automation: "gh", key, names: {} }], w.at());
		w.automations.ownerPut("gh", cooled, 0, true);
		const before = cooling();
		match("one");
		match("two");
		match("three");
		const during = cooling();
		await w.later(61_000);

		expect([before, during, cooling()]).toEqual([[false], [true], [false]]);
		expect(w.automations.log().map((row) => row.outcome)).toEqual(["suppressed"]);
	});

	it("leaves an event automation's leading tells with no message to the lane, named or not, and tells the rest in order", async () => {
		const quiet = { kind: "do", action: "tell_assistant", args: { when: lit("now") } } as const;
		const named = world();
		const flat = world();
		named.save(pointing(event), [quiet, turn("on"), quiet]);
		flat.automations.ownerPut(
			"warm",
			{
				enabled: true,
				trigger: event,
				actions: [
					{ kind: "tell_assistant", when: "quietly" },
					{ kind: "device_set", device: PLUG, verb: "on" },
					{ kind: "tell_assistant", when: "now" },
				],
			},
			0,
			true,
		);
		const lane = [named, flat].map((w) => w.automations.eventsOf("github").map((held) => held.when));
		for (const w of [named, flat]) {
			w.automations.fireEvents([{ automation: "warm", key: "one", names: {} }], w.at());
			await w.automations.settled();
		}

		expect(lane).toEqual([["now"], ["quietly"]]);
		expect([named, flat].map((w) => [w.effects, w.automations.queued().events.length])).toEqual([
			[[`${PLUG}:on`], 1],
			[[`${PLUG}:on`], 1],
		]);
	});

	it("tells every event of a burst for an automation that only tells, past its waiting cap, in the one pass that recorded them", async () => {
		const burst = (message: string) => {
			const w = world();
			const note: AutomationInput = {
				enabled: true,
				trigger: event,
				actions: [{ kind: "tell_assistant", when: "quietly", message }],
			};
			w.automations.ownerPut("note", note, 0, true);
			w.automations.fireEvents(
				Array.from({ length: 12 }, (_, n) => ({
					automation: "note",
					key: `k${n}`,
					names: { event: { value: { title: `T${n}` } } },
				})),
				w.at(),
			);
			return w;
		};
		const plain = burst("Got one");
		const atOnce = plain.automations.outbox.events().length;
		const filled = burst("Got {event.title}");
		await filled.automations.settled();

		expect(atOnce).toBe(12);
		expect(filled.automations.outbox.events().map((held) => held.fields.message)).toEqual(
			Array.from({ length: 12 }, (_, n) => `Got T${n}`),
		);
		expect(filled.automations.log().map((row) => row.outcome)).toEqual(Array.from({ length: 12 }, () => "ran"));
	});

	it("keeps a run whose own tell filled to nothing, telling it with no message", async () => {
		const w = world();
		w.answer(unreachable);
		w.automations.ownerPut(
			"flat",
			{
				enabled: true,
				trigger: event,
				actions: [
					{ kind: "tell_assistant", when: "quietly", message: '{""}' },
					{ kind: "device_set", device: PLUG, verb: "on" },
				],
			},
			0,
			true,
		);
		w.automations.fireEvents([{ automation: "flat", key: "one", names: {} }], w.at());
		await w.automations.settled();
		w.restartWith((rows) => rows);
		w.answer(() => ({ word: "done" }));
		await w.later(6_000);

		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`]);
		expect(w.automations.outbox.events().map((held) => held.fields.message)).toEqual([undefined]);
	});

	it("tells a function's leading tell the lane never told, though an edit moved it to the front while its run waited", async () => {
		const quiet = { kind: "do", action: "tell_assistant", args: { when: lit("now") } } as const;
		const w = world();
		w.save(pointing(event), [turn("on"), quiet]);
		w.answer(unreachable);
		const lane = w.automations.eventsOf("github").map((held) => held.when);
		for (const key of ["one", "two"]) {
			w.automations.fireEvents([{ automation: "warm", key, names: {} }], w.at());
			await w.automations.settled();
		}
		w.save(pointing(event), [quiet, turn("on")], { automation: 1, function: 1 });
		w.answer(() => ({ word: "done" }));
		await w.later(6_000);

		expect(lane).toEqual([null]);
		expect(w.automations.outbox.events()).toHaveLength(2);
	});

	it("starts a waiting run in the pump where the run before it ended at its turn", async () => {
		const w = world();
		w.save(pointing({ kind: "interval", everyMin: 1 }, { keepTryingMin: 1 }), [turn("on")]);
		w.answer(unreachable);
		await w.later(60_000);
		await w.later(60_000);

		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`]);
		expect(w.rows()).toEqual([
			["device_set", "refused", "it could not be reached"],
			["run_function", "refused", CALL_FAILED],
		]);
	});

	it("counts the event trigger's cool-down from admission, so a failing run still cools down", async () => {
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

	it("admits nothing inside the event trigger's cool-down, logging it once until a run comes between", async () => {
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
				actions: [{ kind: "run_function", function: "warm-up", values: { room: FAN } }],
				keepTryingMin: 60,
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

describe("the stored log", () => {
	it("keeps its rows in the shape the build before reads, and what stands beside them", async () => {
		const w = world();
		w.answer(() => ({ word: "refused" }));
		w.save(pointing(hourly), [turn("on")]);
		await w.later(HOUR);
		const stored = w.state();
		const before = ["automation", "seq", "at", "outcome", "reason", "action", "step", "function"];

		expect(stored.log.length).toBeGreaterThan(0);
		expect(stored.log.every((row: object) => Object.keys(row).every((key) => before.includes(key)))).toBe(true);
		expect(stored.standing.warm).toBeDefined();
	});
});

describe("a run by hand", () => {
	const message = (text: string) =>
		({ kind: "do", action: "ifttt_trigger", args: { event: lit("by-hand"), value1: lit(text) } }) as const;

	it("runs once per call id with the names its trigger gives now, and is the last run", async () => {
		const w = world();
		w.save(pointing(hourly), [message("at {time}")]);

		const first = w.console.run("warm", "call-1");
		await w.automations.settled();
		// A lost answer, asked again.
		const again = w.console.run("warm", "call-1");
		await w.automations.settled();
		w.console.run("warm", "call-2");
		await w.automations.settled();

		expect([first, again]).toEqual([{ ran: true }, { ran: true }]);
		expect(w.effects).toHaveLength(2);
		expect(w.effects[0]).toMatch(/^ifttt:by-hand:at \d/);
		expect(w.automations.listing().automations.find((row) => row.id === "warm")?.lastRun).toMatchObject({
			running: false,
			steps: [
				{ path: "0", outcome: "ran" },
				{ path: "0.0", outcome: "ran" },
			],
		});
	});

	it("is refused off, away from the home for an event, and for an automation that is gone", () => {
		const w = world();
		w.save({ ...pointing(hourly), enabled: false }, [turn("on")]);
		const off = w.console.run("warm", "a");
		w.save(pointing(event), [turn("on")], { automation: 1, function: 1 });

		expect([off, w.console.run("gone", "b")]).toEqual([
			{ ran: false, refusal: "off" },
			{ ran: false, refusal: "gone" },
		]);
		expect(w.console.run("warm", "c")).toEqual({ ran: true });
	});

	it("ignores an event's cool-down and leaves a waiting fire in place", async () => {
		const w = world();
		w.save(pointing(event, { coolDownSec: 3_600 }), [turn("on")]);
		w.automations.fireEvents([{ automation: "warm", key: "first", names: {} }], 1_000_000);
		await w.automations.settled();

		expect(w.console.run("warm", "now")).toEqual({ ran: true });
		await w.automations.settled();
		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`]);
	});
});

describe("the last run", () => {
	const last = (w: ReturnType<typeof world>) =>
		w.automations.listing().automations.find((row) => row.id === "warm")?.lastRun;
	const tree: AutomationFunctionInput["steps"] = [
		{ kind: "if", when: "true", steps: [turn("on")], else: [ifttt("never")] },
		{ kind: "wait", minutes: lit(5) },
		ifttt("after"),
	];

	it("is served on the row with every step it reached, the side taken and the step in flight, until it ends", async () => {
		const w = world();
		w.save(pointing(hourly), tree);
		await w.later(HOUR);
		const waiting = last(w);
		await w.later(5 * 60_000 + 1_000);

		expect(waiting).toMatchObject({
			running: true,
			active: "0.1",
			steps: [
				{ path: "0", kind: "run_function" },
				{ path: "0.0", kind: "if", outcome: "ran", side: "then", function: "warm-up" },
				{ path: "0.0.0.0", kind: "device_set", outcome: "ran", function: "warm-up" },
				{ path: "0.1", kind: "wait", function: "warm-up" },
			],
		});
		expect(last(w)).toMatchObject({ running: false, revision: 1 });
		expect(last(w)?.active).toBeUndefined();
		expect(last(w)?.steps.map((step) => [step.path, step.outcome])).toEqual([
			["0", "ran"],
			["0.0", "ran"],
			["0.0.0.0", "ran"],
			["0.1", "ran"],
			["0.2", "ran"],
		]);
	});

	it("times each step from the run's start, and says an open step is retrying", async () => {
		const w = world();
		w.save(pointing(hourly), tree);
		await w.later(HOUR);
		await w.later(5 * 60_000 + 1_000);
		const timed = last(w)?.steps.map((step) => [step.path, step.startMs, step.endMs]);
		const retry = world();
		retry.answer(unreachable);
		retry.save(pointing(hourly), [turn("on")]);
		await retry.later(HOUR);

		expect(timed).toEqual([
			["0", 0, 301_000],
			["0.0", 0, 0],
			["0.0.0.0", 0, 0],
			["0.1", 0, 301_000],
			["0.2", 301_000, 301_000],
		]);
		expect(last(retry)?.steps.find((step) => step.path === "0.0")).toMatchObject({
			startMs: 0,
			retrying: true,
			retriedMs: 0,
		});
	});

	it("leaves a run recorded untimed without times", () => {
		const ended = { attempts: 1, word: "done", verdict: "done" } as const;
		const fire = { member: "m", automation: "warm", incarnation: "i", at: 1_000, revision: 1 } as Fire;
		const ports = {
			kindAt: () => "device_set",
			functionAt: () => undefined,
			stampOf: () => ({ body: "", functions: [] }),
			orderOf: () => 0,
		};
		const untimed: LastRuns = {
			warm: {
				member: "m",
				incarnation: "i",
				order: 0,
				stamp: ports.stampOf(),
				run: {
					at: 1_000,
					revision: 1,
					steps: [{ path: "0", kind: "device_set", outcome: "ran" }],
					running: true,
				},
			},
		};
		const later = { ...fire, steps: { "0": ended, "1": ended }, active: [] };
		const times = (held: LastRuns) =>
			recorded(held, later, false, ports, 5_000).warm?.run.steps.map((step) => [step.startMs, step.endMs]);

		expect(times(untimed)).toEqual([
			[undefined, undefined],
			[undefined, undefined],
		]);
		expect(times({})).toEqual([
			[4_000, 4_000],
			[4_000, 4_000],
		]);
		// The clock went back after the step began.
		const begun = {
			warm: {
				...untimed.warm!,
				run: { ...untimed.warm!.run, steps: [{ path: "0", kind: "device_set", startMs: 6_000 }] },
			},
		};
		expect(recorded(begun, later, false, ports, 5_000).warm?.run.steps[0]).toMatchObject({
			startMs: 6_000,
			endMs: 6_000,
		});
	});

	it("says why a step failed, keeps through a toggle, and is gone once what it runs is edited", async () => {
		const w = world();
		w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
		w.save(pointing(hourly), [turn("on"), ifttt("after")]);
		await w.later(HOUR);
		const failed = last(w)?.steps.find((step) => step.path === "0.0");
		w.automations.ownerPut("warm", { ...pointing(hourly), enabled: false }, 1, true);
		const toggled = last(w);
		w.automations.ownerPut("warm", pointing(hourly), 2, true);
		w.save(pointing(hourly), [turn("on")], { automation: 3, function: 1 });
		const edited = last(w);

		expect(failed).toMatchObject({ outcome: "refused", reason: "it was refused" });
		expect(toggled?.steps).toHaveLength(3);
		expect(edited).toBeUndefined();
	});

	it("is hidden when a function it entered twice ran at two versions", async () => {
		const w = world();
		const call = { kind: "call" as const, function: "inner" };
		const inner = (event: string) => ({ name: "Inner", params: [], steps: [ifttt(event)] });
		const save = (bases: { automation: number; function: number; inner: number }, body: AutomationFunctionInput) =>
			w.automations.save({
				id: "warm",
				body: pointing(hourly),
				base: bases.automation,
				function: {
					as: "edit",
					id: "warm-up",
					body: { name: "Warm up", params: room, steps: [call, { kind: "wait", minutes: lit(5) }, call] },
					base: bases.function,
				},
				called: [{ id: "inner", body, base: bases.inner }],
				confirmed: true,
			});
		save({ automation: 0, function: 0, inner: 0 }, inner("first"));
		await w.later(HOUR);
		const edited = save({ automation: 1, function: 1, inner: 1 }, inner("second"));
		await w.later(5 * 60_000 + 1_000);

		expect(edited.stored).toBe(true);
		expect(w.effects).toEqual(["ifttt:first", "ifttt:second"]);
		expect(last(w)).toBeUndefined();
	});

	it("is replaced by the next run, and a run that keeps going on a version an edit replaced writes none", async () => {
		const w = world();
		w.save(pointing(hourly), [{ kind: "wait", minutes: lit(5) }, ifttt("old")]);
		await w.later(HOUR);
		w.save(pointing(hourly), [ifttt("new")], { automation: 1, function: 1 });
		await w.later(5 * 60_000 + 1_000);
		const afterEdit = last(w);
		await w.later(HOUR - 5 * 60_000);

		expect(w.effects).toEqual(["ifttt:old", "ifttt:new"]);
		expect(afterEdit).toBeUndefined();
		expect(last(w)?.steps.map((step) => step.path)).toEqual(["0", "0.0"]);
	});
});

describe("a tree of steps", () => {
	it("takes the side its condition holds, skips the other, and carries on after either", async () => {
		const w = world();
		w.save(pointing(hourly), [
			{ kind: "if", when: "1 < 2", steps: [turn("on")], else: [turn("off")] },
			{ kind: "if", when: "1 > 2", steps: [ifttt("no")], else: [ifttt("yes")] },
			{ kind: "if", when: "false", steps: [ifttt("never")] },
			{ kind: "note", text: "then tell" },
			ifttt("after"),
		]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:on`, "ifttt:yes", "ifttt:after"]);
		expect(w.where()).toEqual([
			["0.0.0.0", "warm-up"],
			["0.1.1.0", "warm-up"],
			["0.4", "warm-up"],
		]);
	});

	it("catches a failure with what failed, skips the rest of the try, and fails nothing", async () => {
		const w = world();
		w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
		w.save(pointing(hourly), [
			{ kind: "try", steps: [turn("on"), ifttt("skipped")], catch: [ifttt("caught", "{e.code}: {e}")] },
			ifttt("after"),
		]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:on`, "ifttt:caught:refused: it was refused", "ifttt:after"]);
		expect(w.rows()).toEqual([
			["device_set", "refused", "it was refused"],
			["ifttt_trigger", "ran", undefined],
			["ifttt_trigger", "ran", undefined],
		]);
	});

	it("throws to its try with its text, and outside one ends the function failed", async () => {
		const w = world();
		w.save(pointing(hourly), [
			{
				kind: "try",
				steps: [{ kind: "throw", text: "too warm by {room}" }, ifttt("skipped")],
				catch: [ifttt("caught", "{e}")],
			},
			{ kind: "throw" },
			ifttt("never"),
		]);
		await w.later(HOUR);

		expect(w.effects).toEqual(["ifttt:caught:too warm by Lamp"]);
		expect(w.rows()).toEqual([
			["throw", "refused", THROWN],
			["ifttt_trigger", "ran", undefined],
			["throw", "refused", THROWN],
			["run_function", "refused", CALL_FAILED],
		]);
	});

	it("exits quietly, the steps after it unreached", async () => {
		const w = world();
		w.save(pointing(hourly), [turn("on"), { kind: "if", when: "true", steps: [{ kind: "exit" }] }, turn("off")]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:on`]);
		expect(w.rows()).toEqual([["device_set", "ran", undefined]]);
	});

	it("keeps a value under a name for the steps and conditions after it", async () => {
		const w = world();
		w.save(pointing(hourly), [
			{ kind: "let", name: "level", value: lit(5) },
			{ kind: "let", name: "twice", value: expr("level * 2") },
			{ kind: "if", when: "twice > 9", steps: [ifttt("high", "{twice}")] },
		]);
		await w.later(HOUR);

		expect(w.effects).toEqual(["ifttt:high:10"]);
	});

	it("fills a kept string's holes at its turn, keeps a literal as written, and saves a hole it cannot read as its error", async () => {
		const w = world();
		w.save(pointing(hourly), [
			{ kind: "let", name: "level", value: lit(5) },
			{ kind: "let", name: "label", value: filled("Level {level}, braces \\{kept\\}") },
			{ kind: "let", name: "raw", value: lit("as {written} \\\\ here") },
			ifttt("said", "{label} / {raw}"),
		]);
		await w.later(HOUR);
		const unread = world().saveOp(pointing(hourly), [
			{ kind: "let", name: "label", value: filled("Is {nowhere}") },
			turn("on"),
		]);
		const written = world().saveOp(pointing(hourly), [
			{ kind: "let", name: "label", value: lit("Is {nowhere}") },
			turn("on"),
		]);

		expect(w.effects).toEqual(["ifttt:said:Level 5, braces {kept} / as {written} \\\\ here"]);
		expect(unread).toMatchObject({
			stored: true,
			issues: [{ level: "error", step: "0", param: "value", start: 5, end: 12 }],
		});
		expect(written).toMatchObject({ stored: true });
		expect(written).not.toHaveProperty("issues");
	});

	it("fails an if whose condition cannot be read or is no true or false, taking neither side", async () => {
		const w = world();
		w.save(pointing(hourly), [
			{ kind: "if", when: "room.missing", steps: [turn("on")], else: [turn("on")] },
			{ kind: "if", when: "1 + 1", steps: [turn("on")] },
			turn("off"),
		]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:off`]);
		expect(w.rows()).toEqual([
			["if", "refused", CONDITION_UNREAD],
			["if", "refused", NOT_TRUE_OR_FALSE],
			["device_set", "ran", undefined],
			["run_function", "refused", CALL_FAILED],
		]);
	});

	it("waits its minutes before the next step, and a restart does not start the wait again", async () => {
		const w = world();
		w.save(pointing(hourly), [turn("on"), { kind: "wait", minutes: lit(5) }, turn("off")]);
		await w.later(HOUR);
		await w.later(4 * 60_000);
		const during = [...w.effects];
		w.restartWith((rows) => rows);
		await w.later(61_000);

		expect([during, w.effects]).toEqual([[`${PLUG}:on`], [`${PLUG}:on`, `${PLUG}:off`]]);
	});

	it("keeps a run in a wait through 64 newer fires of its automation", async () => {
		const w = world();
		w.save(pointing(event), [turn("on"), { kind: "wait", minutes: lit(30) }, turn("off")]);
		for (let n = 0; n < 65; n++) {
			w.automations.fireEvents([{ automation: "warm", key: `k${n}`, names: {} }], w.at());
			await w.automations.settled();
		}
		const during = [...w.effects];
		await w.later(30 * 60_000);

		expect(during).toEqual([`${PLUG}:on`]);
		expect(w.effects.slice(0, 2)).toEqual([`${PLUG}:on`, `${PLUG}:off`]);
	});

	it("runs a step after a wait though another automation set its switch during the wait", async () => {
		const w = world();
		const other = (enabled: boolean): AutomationInput => ({
			enabled,
			trigger: { kind: "interval", everyMin: 1 },
			actions: [{ kind: "device_set", device: PLUG, verb: "on" }],
		});
		w.save(pointing(event), [turn("on"), { kind: "wait", minutes: lit(5) }, turn("off")]);
		w.automations.fireEvents([{ automation: "warm", key: "once", names: {} }], w.at());
		await w.automations.settled();
		w.automations.ownerPut("other", other(true), 0, true);
		await w.later(60_000);
		w.automations.ownerPut("other", other(false), 1, true);
		await w.later(4 * 60_000 + 1_000);

		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`, `${PLUG}:off`]);
	});

	it("drops a read that lands after its run was replaced under the same event", async () => {
		const w = world();
		const titled = (title: string) => [{ automation: "warm", key: "same", names: { event: { value: { title } } } }];
		w.save(pointing(event), [
			{ kind: "if", when: 'event.title == "old"', steps: [turn("on")], else: [turn("off")] },
		]);
		const release = w.holdReads();
		w.automations.fireEvents(titled("old"), w.at());
		await Promise.resolve();
		w.automations.ownerPut("warm", { ...pointing(event), enabled: false }, 1, true);
		w.automations.ownerPut("warm", pointing(event), 2, true);
		w.automations.ownerPut(
			"other",
			{ enabled: true, trigger: event, actions: [{ kind: "tell_assistant", when: "quietly", message: "x" }] },
			0,
			true,
		);
		w.automations.fireEvents(
			Array.from({ length: 257 }, (_, n) => ({ automation: "other", key: `other${n}`, names: {} })),
			w.at(),
		);
		w.automations.fireEvents(titled("new"), w.at());
		release();
		await w.automations.settled();

		expect(w.effects).toEqual([`${PLUG}:off`]);
	});

	it("keeps what a catch caught and a let kept across a restart", async () => {
		const w = world();
		w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
		w.save(pointing(hourly), [
			{ kind: "let", name: "level", value: lit(7) },
			{
				kind: "try",
				steps: [turn("on")],
				catch: [{ kind: "wait", minutes: lit(5) }, ifttt("caught", "{e.code} at {level}")],
			},
		]);
		await w.later(HOUR);
		w.restartWith((rows) => rows);
		await w.later(5 * 60_000 + 1_000);

		expect(w.effects).toEqual([`${PLUG}:on`, "ifttt:caught:refused at 7"]);
	});

	it("fails a let whose value is past its bytes, counted as stored", async () => {
		const w = world();
		const wide = String.fromCharCode(0x754c).repeat(500);
		w.save(pointing(hourly), [{ kind: "let", name: "wide", value: lit(wide) }, ifttt("after")]);
		await w.later(HOUR);

		expect(w.rows()).toEqual([
			["let", "refused", VALUE_TOO_LARGE],
			["ifttt_trigger", "ran", undefined],
			["run_function", "refused", CALL_FAILED],
		]);
	});

	it("saves a name already taken, a wait out of range, a blank condition or value, and a condition it cannot read, assigns or holds twice, at any depth, each as its error", () => {
		const bodies: AutomationFunctionInput["steps"][] = [
			[{ kind: "let", name: "room", value: lit(1) }],
			[{ kind: "if", when: "room = 1" }],
			[{ kind: "if", when: "true; false" }],
			[{ kind: "let", name: "count", value: expr("count = 2") }],
			[{ kind: "wait", minutes: lit(-1) }],
			[{ kind: "wait", minutes: lit(2_000) }],
			[{ kind: "if", when: "nobody > 1" }],
			[{ kind: "try", steps: [{ kind: "if", when: "(", steps: [turn("on")] }], catch: [] }],
			[{ kind: "if", when: "true", else: [{ kind: "throw", text: "{nobody}" }] }],
			[{ kind: "if", when: "true} ignored {false", steps: [turn("on")] }],
			[turn("on", expr("room} {room"))],
			[{ kind: "if", when: "", steps: [turn("on")] }],
			[{ kind: "let", name: "count", value: expr("") }],
		];

		expect(
			bodies.map((steps) => {
				const saved = world().saveOp(pointing(hourly), steps);
				return [saved.stored, saved.issues?.map((issue) => issue.level)];
			}),
		).toEqual(bodies.map(() => [true, ["error"]]));
	});

	it("names the step an issue sits in by its numbers, at any depth", () => {
		const bodies: AutomationFunctionInput["steps"][] = [
			[{ kind: "if", when: "true", steps: [{ kind: "throw", text: "{nobody}" }] }],
			[{ kind: "try", steps: [turn("on")], catch: [turn("on"), { kind: "wait", minutes: lit(-1) }] }],
			[turn("on"), { kind: "if", when: "true", else: [{ kind: "let", name: "room", value: lit(1) }] }],
			[turn("on"), ifttt("bell", "{nobody}")],
		];
		const issued = bodies.map((steps) => {
			const [issue] = world().saveOp(pointing(hourly), steps).issues ?? [];
			return [issue?.record, issue?.step, issue?.param];
		});

		expect(issued).toEqual([
			["function", "0.0.0", "text"],
			["function", "0.1.1", "minutes"],
			["function", "1.1.0", "name"],
			["function", "1", "value1"],
		]);
	});

	it("fails a broken step at its turn after the steps before it ran, and a try catches it", async () => {
		const w = world();
		const broken = { kind: "wait", minutes: lit(-1) } as const;
		w.save(pointing(hourly), [
			turn("on"),
			{ kind: "try", steps: [broken, turn("off")], catch: [ifttt("caught", "{e.code}")] },
			broken,
			ifttt("after"),
		]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:on`, "ifttt:caught:unread", "ifttt:after"]);
		expect(w.rows()).toEqual([
			["device_set", "ran", undefined],
			["wait", "refused", STEP_ERRORS],
			["ifttt_trigger", "ran", undefined],
			["wait", "refused", STEP_ERRORS],
			["ifttt_trigger", "ran", undefined],
			["run_function", "refused", CALL_FAILED],
		]);
	});

	it("refuses a body nested past its depth or holding too many steps, and counts an else-if at its parent's depth", () => {
		const nest = (depth: number): AutomationFunctionInput["steps"] =>
			depth === 0 ? [{ kind: "exit" }] : [{ kind: "if", when: "true", steps: nest(depth - 1) }];
		const chain = (links: number): AutomationFunctionInput["steps"] =>
			links === 0 ? [] : [{ kind: "if", when: "true", steps: [{ kind: "exit" }], else: chain(links - 1) }];
		const elsePair = (depth: number): AutomationFunctionInput["steps"] =>
			depth === 0
				? [{ kind: "exit" }]
				: [{ kind: "if", when: "true", else: [{ kind: "exit" }, ...elsePair(depth - 1)] }];
		const wide = (lists: number): AutomationFunctionInput["steps"] =>
			Array.from({ length: lists }, () => ({
				kind: "if" as const,
				when: "true",
				steps: Array.from({ length: 8 }, () => ({ kind: "exit" as const })),
			}));
		const parses = (steps: AutomationFunctionInput["steps"]) =>
			FunctionSchema.safeParse({ name: "Deep", params: [], steps }).success;

		expect([nest(3), nest(4), wide(3), wide(4)].map(parses)).toEqual([true, false, true, false]);
		expect([chain(8), elsePair(3), elsePair(4)].map(parses)).toEqual([true, true, false]);
	});
});

describe("a function calling another", () => {
	const call = (fn: string, values?: Record<string, StepArg>) => ({
		kind: "call" as const,
		function: fn,
		...(values ? { values } : {}),
	});
	const passing = call("inner", { room: expr("room") });
	/** A switched-off automation of its own points at it, so the save op can write it. */
	const held = (
		w: ReturnType<typeof world>,
		id: string,
		steps: AutomationFunctionInput["steps"],
		bases = { automation: 0, function: 0 },
	) =>
		w.automations.save({
			id: `h-${id}`,
			body: {
				enabled: false,
				trigger: hourly,
				actions: [{ kind: "run_function", function: id, values: { room: PLUG } }],
			},
			base: bases.automation,
			function: { as: "edit", id, body: { name: id, params: room, steps }, base: bases.function },
			confirmed: true,
		});
	const inner = (
		w: ReturnType<typeof world>,
		steps: AutomationFunctionInput["steps"],
		bases = { automation: 0, function: 0 },
	) => held(w, "inner", steps, bases);
	const toLeaf = call("leaf", { room: expr("room") });
	const calls = (count: number) => Array.from({ length: count }, () => passing);

	it("runs a callee's steps under its call with the values the call gives, then carries on", async () => {
		const w = world();
		inner(w, [ifttt("inner", "{room}")]);
		w.save(pointing(hourly), [turn("on"), call("inner", { room: lit(FAN) }), ifttt("after")]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:on`, "ifttt:inner:Fan", "ifttt:after"]);
		expect(w.where()).toEqual([
			["0.0", "warm-up"],
			["0.1.0", "inner"],
			["0.2", "warm-up"],
		]);
	});

	it("fills the holes of a text a call gives, read where the call runs, and gives a literal as written", async () => {
		const w = world();
		w.automations.save({
			id: "h-say",
			body: {
				enabled: false,
				trigger: hourly,
				actions: [{ kind: "run_function", function: "say", values: { line: "x" } }],
			},
			base: 0,
			function: {
				as: "edit",
				id: "say",
				body: { name: "say", params: [{ name: "line", type: "text" }], steps: [ifttt("inner", "{line}")] },
				base: 0,
			},
			confirmed: true,
		});
		w.save(pointing(hourly), [
			{ kind: "let", name: "level", value: lit(7) },
			call("say", { line: filled("Level {level}") }),
			call("say", { line: lit("Level {level}") }),
		]);
		await w.later(HOUR);

		expect(w.effects).toEqual(["ifttt:inner:Level 7", "ifttt:inner:Level {level}"]);

		// A filled text is a text: a number it can never be is the save's error.
		const counted = world();
		counted.automations.save({
			id: "h-count",
			body: {
				enabled: false,
				trigger: hourly,
				actions: [{ kind: "run_function", function: "count", values: { times: 1 } }],
			},
			base: 0,
			function: {
				as: "edit",
				id: "count",
				body: { name: "count", params: [{ name: "times", type: "number" }], steps: [ifttt("inner")] },
				base: 0,
			},
			confirmed: true,
		});
		expect(counted.saveOp(pointing(hourly), [call("count", { times: filled("{1}") })])).toMatchObject({
			stored: true,
			issues: [{ level: "error", record: "function", id: "warm-up", step: "0" }],
		});
		const fits = counted.saveOp(pointing(hourly), [call("count", { times: expr("1") })], {
			automation: 1,
			function: 1,
		});
		expect(fits).toMatchObject({ stored: true });
		expect(fits).not.toHaveProperty("issues");
	});

	it("enters a callee holding a broken step, runs its steps before it, fails that step at its turn, and fails the call", async () => {
		const w = world();
		inner(w, [ifttt("first"), { kind: "wait", minutes: lit(-1) }, ifttt("rest")]);
		w.save(pointing(hourly), [passing, ifttt("after")]);
		await w.later(HOUR);

		expect(w.effects).toEqual(["ifttt:first", "ifttt:rest", "ifttt:after"]);
		expect(w.rows()).toEqual([
			["ifttt_trigger", "ran", undefined],
			["wait", "refused", STEP_ERRORS],
			["ifttt_trigger", "ran", undefined],
			["run_function", "refused", CALL_FAILED],
			["ifttt_trigger", "ran", undefined],
			["run_function", "refused", CALL_FAILED],
		]);
		expect(w.where().slice(0, 4)).toEqual([
			["0.0.0", "inner"],
			["0.0.1", "inner"],
			["0.0.2", "inner"],
			["0.0", "warm-up"],
		]);
	});

	it("catches a callee's failure in its caller's try, as the call's own", async () => {
		const w = world();
		w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
		inner(w, [turn("on")]);
		w.save(pointing(hourly), [
			{ kind: "try", steps: [passing, ifttt("skipped")], catch: [ifttt("caught", "{e.code}")] },
			ifttt("after"),
		]);
		await w.later(HOUR);

		expect(w.effects).toEqual([`${PLUG}:on`, "ifttt:caught:call_failed", "ifttt:after"]);
		expect(w.rows().map(([action, outcome]) => [action, outcome])).toEqual([
			["device_set", "refused"],
			["run_function", "refused"],
			["ifttt_trigger", "ran"],
			["ifttt_trigger", "ran"],
		]);
	});

	it("finishes a run waiting inside a callee on the steps it entered, whatever an edit made of it", async () => {
		const w = world();
		inner(w, [{ kind: "wait", minutes: lit(5) }, ifttt("old")]);
		w.save(pointing(hourly), [passing]);
		await w.later(HOUR);
		const edited = inner(w, [ifttt("new")], { automation: 1, function: 1 });
		await w.later(5 * 60_000 + 1_000);

		expect([edited.stored, w.effects]).toEqual([true, ["ifttt:old"]]);
	});

	it("refuses at the save a call that closes a loop, and fails at the run one an edit closed behind a waiting run", async () => {
		const w = world();
		const back = call("warm-up", { room: expr("room") });
		inner(w, [turn("on")]);
		w.save(pointing(hourly), [{ kind: "wait", minutes: lit(5) }, passing]);
		const closing = inner(w, [back], { automation: 1, function: 1 });
		await w.later(HOUR);
		w.save(pointing(hourly), [turn("off")], { automation: 1, function: 1 });
		const behind = inner(w, [back], { automation: 1, function: 1 });
		await w.later(5 * 60_000 + 1_000);

		expect([closing.stored, behind.stored]).toEqual([false, true]);
		expect(w.effects).toEqual([]);
		expect(w.rows()).toEqual([
			["run_function", "refused", CALL_LOOPS],
			["run_function", "refused", CALL_FAILED],
			["run_function", "refused", CALL_FAILED],
		]);
	});

	it("refuses at the save a body that would enter more functions than one run may", () => {
		const w = world();
		held(w, "leaf", [ifttt("leaf")]);
		inner(w, [toLeaf]);
		const few = w.save(pointing(hourly), calls(7));
		const many = w.save(pointing(hourly), calls(8), { automation: 1, function: 1 });

		expect([few.stored, many.stored]).toEqual([true, false]);
	});

	it("fails the calls past what one run may enter, when edits behind a waiting run made its path longer", async () => {
		const w = world();
		held(w, "leaf", [ifttt("leaf")]);
		inner(w, [toLeaf]);
		w.save(pointing(hourly), [{ kind: "wait", minutes: lit(5) }, ...calls(7)]);
		await w.later(HOUR);
		w.save(pointing(hourly), [passing], { automation: 1, function: 1 });
		const longer = inner(w, [toLeaf, toLeaf], { automation: 1, function: 1 });
		await w.later(5 * 60_000 + 1_000);

		expect(longer.stored).toBe(true);
		expect(w.effects).toEqual(Array.from({ length: 10 }, () => "ifttt:leaf"));
		expect(w.rows().filter(([, , reason]) => reason === TOO_MANY_CALLS).length).toBe(2);
	});

	it("keeps a function another calls when the automation that pointed at it goes", async () => {
		const w = world();
		inner(w, [ifttt("inner")]);
		w.save(pointing(hourly), [passing]);
		const removed = w.automations.ownerRemove("h-inner", 1);
		await w.later(HOUR);

		expect([removed.deleted, w.effects]).toEqual([true, ["ifttt:inner"]]);
	});

	it("refuses at the save a call to a function not held, and saves one that leaves a value unset or whose value does not fit as its error", () => {
		const saved = (step: AutomationFunctionInput["steps"][number]) => {
			const w = world();
			inner(w, [ifttt("inner")]);
			const answer = w.saveOp(pointing(hourly), [step]);
			return [answer.stored, answer.issues?.map((issue) => issue.level)];
		};
		const calls = [
			call("gone"),
			call("inner"),
			call("inner", { room: lit(5) }),
			call("inner", { room: lit("aa:bb:cc:dd:ee:99") }),
			call("inner", { room: expr("nobody") }),
			call("inner", { room: expr("room"), other: lit("x") }),
			passing,
		];

		const issued = [true, ["error"]];
		expect(calls.map(saved)).toEqual([
			[false, undefined],
			issued,
			issued,
			issued,
			issued,
			issued,
			[true, undefined],
		]);
	});

	it("holds a call to its function's declared types before any of its steps run: a trigger's name as the save's error, a read value at its entry", async () => {
		const calling = (
			w: ReturnType<typeof world>,
			callee: string,
			params: AutomationFunctionInput["params"],
			values?: Record<string, StepArg>,
		) =>
			w.automations.saveOp({
				automationId: "warm",
				automation: AutomationSchema.parse(pointing(hourly)),
				automationBase: 0,
				function: {
					as: "edit",
					id: "warm-up",
					body: FunctionSchema.parse({ name: "Warm up", params: room, steps: [call(callee, values)] }),
					base: 0,
				},
				called: [
					{
						id: callee,
						body: FunctionSchema.parse({
							name: callee,
							params,
							steps: [ifttt("inner"), { kind: "wait", minutes: expr("1") }],
						}),
						base: 0,
					},
				],
				confirmed: true,
			});
		const timed = world();
		const leveled = world();
		const clock = calling(timed, "timed", [{ name: "time", type: "number" }]);
		const read = calling(leveled, "leveled", [{ name: "level", type: "number" }], { level: expr("room") });
		await timed.later(HOUR);
		await leveled.later(HOUR);

		expect([
			clock.stored,
			clock.issues?.map((issue) => [issue.level, issue.step]),
			read.stored,
			read.issues,
		]).toEqual([true, [["error", "0"]], true, undefined]);
		for (const w of [timed, leveled]) {
			expect(w.effects).toEqual([]);
			expect(w.rows().map(([action, outcome]) => [action, outcome])).toEqual([
				["run_function", "refused"],
				["run_function", "refused"],
			]);
		}
	});

	it("refuses an edit of a callee that would stop a caller's call fitting", () => {
		const w = world();
		inner(w, [ifttt("inner")]);
		w.save(pointing(hourly), [passing]);
		const widened = w.automations.save({
			id: "helper",
			body: {
				enabled: false,
				trigger: hourly,
				actions: [{ kind: "run_function", function: "inner", values: { room: PLUG, level: 3 } }],
			},
			base: 1,
			function: {
				as: "edit",
				id: "inner",
				body: { name: "Inner", params: [...room, { name: "level", type: "number" }], steps: [ifttt("inner")] },
				base: 1,
			},
			confirmed: true,
		});

		expect(widened.stored).toBe(false);
	});
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

	describe("tasks started beside the steps that follow", () => {
		type Steps = AutomationFunctionInput["steps"];
		const start = (as: string | undefined, ...steps: Steps) => ({
			kind: "start" as const,
			...(as === undefined ? {} : { as }),
			steps,
		});
		const awaiting = (task: string, as?: string) => ({
			kind: "await" as const,
			task,
			...(as === undefined ? {} : { as }),
		});
		const wait = (minutes: number) => ({ kind: "wait" as const, minutes: lit(minutes) });
		const lastRun = (w: ReturnType<typeof world>) =>
			w.automations.listing().automations.find((row) => row.id === "warm")?.lastRun;

		it("runs a task beside the steps after it, and the run lasts until the task has ended", async () => {
			const w = world();
			w.save(pointing(hourly), [start("t", wait(5), ifttt("slow")), ifttt("now")]);
			await w.later(HOUR);
			const early = { effects: [...w.effects], running: lastRun(w)?.running };
			await w.later(5 * 60_000);

			expect(early).toEqual({ effects: ["ifttt:now"], running: true });
			expect(w.effects).toEqual(["ifttt:now", "ifttt:slow"]);
			expect(lastRun(w)?.running).toBe(false);
			expect(w.rows().every(([, outcome]) => outcome === "ran")).toBe(true);
		});

		it("waits at an await for its task, and reads how a task stands as it runs", async () => {
			const w = world();
			w.save(pointing(hourly), [
				start("t", wait(1), ifttt("a")),
				{ kind: "if", when: "t.done", steps: [ifttt("early")], else: [ifttt("running", "{t}")] },
				awaiting("t"),
				ifttt("after", "{t} {t.failed}"),
			]);
			await w.later(HOUR);
			const early = [...w.effects];
			await w.later(60_000);

			expect(early).toEqual(["ifttt:running:running"]);
			expect(w.effects).toEqual(["ifttt:running:running", "ifttt:a", "ifttt:after:done no"]);
		});

		it("waits at all for every task, and fails together with each failure, which a try catches", async () => {
			const w = world();
			w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
			w.save(pointing(hourly), [
				start("a", turn("on")),
				start("b", wait(1), ifttt("b")),
				{
					kind: "try",
					steps: [awaiting("all(a, b, a)"), ifttt("unreached")],
					catch: [ifttt("caught", "{e.code} {e.errors.count()} {e.errors[0].code}")],
				},
			]);
			await w.later(HOUR);
			const early = [...w.effects];
			await w.later(60_000);

			expect(early).toEqual([`${PLUG}:on`]);
			expect(w.effects).toEqual([`${PLUG}:on`, "ifttt:b", "ifttt:caught:together 1 refused"]);
			// The failure was awaited, so the call itself did not fail.
			expect(w.rows().some(([action]) => action === "run_function")).toBe(false);
		});

		it("takes the first task to end from any, though both ended before it asked, and leaves nothing behind", async () => {
			const w = world();
			const steps: Steps = [
				start("slow", wait(5), ifttt("slow")),
				start("a", ifttt("a")),
				start("b", wait(1), ifttt("b")),
				wait(2),
				awaiting("any(b, a, slow)", "first"),
				{ kind: "if", when: "first == a", steps: [ifttt("a_first")], else: [ifttt("not_a")] },
			];
			const saved = w.save(pointing(hourly), steps);
			await w.later(HOUR);
			await w.later(60_000);
			await w.later(60_000);
			const asked = { effects: [...w.effects], running: lastRun(w)?.running };

			expect(saved).toMatchObject({ stored: true });
			await w.later(3 * 60_000);

			expect(asked).toEqual({ effects: ["ifttt:a", "ifttt:b", "ifttt:a_first"], running: true });
			expect(w.effects.at(-1)).toBe("ifttt:slow");
			expect(lastRun(w)?.running).toBe(false);
		});

		it("remembers a failed task nobody awaited at the frame's end, and none that one awaited", async () => {
			const w = world();
			w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
			w.save(pointing(hourly), [start(undefined, turn("on")), ifttt("after")]);
			await w.later(HOUR);

			expect([...w.effects].sort()).toEqual([`${PLUG}:on`, "ifttt:after"]);
			expect(w.rows().at(-1)).toEqual(["run_function", "refused", CALL_FAILED]);
		});

		it("lets any take the first and leave a failed loser to the frame, which it does not see", async () => {
			const w = world();
			w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
			w.save(pointing(hourly), [
				start("loser", wait(1), turn("on")),
				start("winner", ifttt("won")),
				awaiting("any(loser, winner)", "first"),
				ifttt("after", "{first == winner}"),
			]);
			await w.later(HOUR);
			await w.later(60_000);

			expect(w.effects).toEqual(["ifttt:won", "ifttt:after:yes", `${PLUG}:on`]);
			expect(w.rows().at(-1)).toEqual(["run_function", "refused", CALL_FAILED]);
		});

		it("refuses an await that names no task, and one that would wait on itself, directly or through another", async () => {
			const w = world();
			w.save(pointing(hourly), [
				awaiting("5"),
				start("t", awaiting("t")),
				start("a", wait(1), awaiting("b")),
				start("b", wait(1), awaiting("a")),
				ifttt("after"),
			]);
			await w.later(HOUR);
			await w.later(60_000);
			const refused = w.rows().filter(([action]) => action === "await");

			// The first of the two that wait on each other is read, and fails with the task it waited on.
			expect(refused).toEqual([
				["await", "refused", NO_TASK],
				["await", "refused", WAITS_FOREVER],
				["await", "refused", WAITS_FOREVER],
				["await", "refused", WAITS_FOREVER],
			]);
			expect(w.effects).toEqual(["ifttt:after"]);
			expect(lastRun(w)?.running).toBe(false);
		});

		it("refuses an await whose any waits only on tasks that wait on it, and the run still ends", async () => {
			const w = world();
			w.save(pointing(hourly), [
				start("a", wait(1), awaiting("any(b, c)")),
				start("b", wait(1), awaiting("a")),
				start("c", wait(1), awaiting("a")),
				ifttt("main"),
			]);
			await w.later(HOUR);
			await w.later(60_000);

			// Once it fails, its task ends, and the two that waited on that task end with it.
			expect(w.rows().filter(([action, outcome]) => action === "await" && outcome === "refused")).toEqual([
				["await", "refused", WAITS_FOREVER],
			]);
			expect(lastRun(w)?.running).toBe(false);
		});

		it("waits on a join of joins, and hands a catch a task's block failure with each branch's", async () => {
			const w = world();
			w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
			w.save(pointing(hourly), [
				start("a", ifttt("a")),
				start("b", wait(1), ifttt("b")),
				start("c", { kind: "parallel", steps: [turn("on"), turn("on", lit(FAN))] }),
				awaiting("all(a, b)", "both"),
				awaiting("any(both, c)", "first"),
				{
					kind: "try",
					steps: [awaiting("c")],
					catch: [ifttt("caught", "{first == both} {e.code} {e.errors.count()}")],
				},
			]);
			await w.later(HOUR);
			await w.later(60_000);

			expect(w.effects.at(-1)).toBe("ifttt:caught:no together 2");
			expect(w.rows().filter(([action, outcome]) => action === "start" && outcome === "refused")).toEqual([
				["start", "refused", "2 of 2 failed"],
			]);
		});

		it("keeps a record shaped like a task as written, and reads a task inside a list as it stands", async () => {
			const w = world();
			w.save(pointing(hourly), [
				start("t", wait(1)),
				{ kind: "let", name: "r", value: expr('{task: "x", n: 5}') },
				{ kind: "let", name: "xs", value: expr("[t]") },
				awaiting("t"),
				ifttt("after", "{r.n} {xs[0].done} {xs[0] == t}"),
			]);
			await w.later(HOUR);
			await w.later(60_000);

			expect(w.effects).toEqual(["ifttt:after:5 yes yes"]);
		});

		it("saves an exit inside a task, a task kept under a name the function takes, and a body too wide, each as its error", () => {
			const many = Array.from({ length: 8 }, () => ifttt("x"));
			/** Each save on a fresh store; its first issue's line. */
			const said = (steps: Steps) => {
				const saved = world().saveOp(pointing(hourly), steps);
				return saved.stored ? (saved.issues?.[0]?.line ?? "stored") : saved.refusal?.line;
			};
			const tried = {
				kind: "try" as const,
				steps: [start(undefined, wait(5)), { kind: "throw" as const }],
				catch: [start(undefined, wait(5))],
			};

			expect([
				said([start(undefined, { kind: "exit" })]),
				said([start("room", ifttt("x"))]),
				said([start(undefined, { kind: "parallel", steps: many }), ifttt("y")]),
				// A catch starts beside what its try started.
				said([tried, { kind: "parallel", steps: many.slice(0, 7) }]),
				said([start("t", ifttt("x")), awaiting("all(t)", "done_t")]),
				// An empty task runs nothing beside.
				said([...many.slice(0, 7).map(() => start(undefined)), { kind: "parallel", steps: many.slice(0, 1) }]),
			]).toEqual([EXIT_BESIDE, NAME_TAKEN, TOO_WIDE, TOO_WIDE, "stored", "stored"]);
			expect(said([awaiting("nowhere")])).not.toBe("stored");
		});

		it("finds a task where it stood after a restart, and the run still waits for it", async () => {
			const w = world();
			w.save(pointing(hourly), [start("t", wait(5), ifttt("slow")), ifttt("now")]);
			await w.later(HOUR);
			await w.automations.stop();
			w.restartWith((rows) => rows);
			const restored = lastRun(w)?.running;
			await w.later(5 * 60_000);

			expect(restored).toBe(true);
			expect(w.effects).toEqual(["ifttt:now", "ifttt:slow"]);
			expect(lastRun(w)?.running).toBe(false);
		});
	});

	describe("a block of steps side by side", () => {
		const block = (...steps: AutomationFunctionInput["steps"]) => ({ kind: "parallel" as const, steps });
		const lane = (...steps: AutomationFunctionInput["steps"]) => ({ kind: "try" as const, steps, catch: [] });

		it("runs each branch on its own: one waits while another sends, and the step after runs once every one has ended", async () => {
			const w = world();
			w.save(pointing(hourly), [
				block(lane({ kind: "wait", minutes: lit(5) }, ifttt("slow")), ifttt("fast")),
				ifttt("after"),
			]);
			await w.later(HOUR);
			const first = [...w.effects];
			await w.later(5 * 60_000);

			expect(first).toEqual(["ifttt:fast"]);
			expect(w.effects).toEqual(["ifttt:fast", "ifttt:slow", "ifttt:after"]);
			expect(w.rows().every(([, outcome]) => outcome === "ran")).toBe(true);
		});

		it("has two plugs' attempts out at once, and sets one plug in the order written though the first has to retry", async () => {
			const w = world();
			const release = w.holdEffects();
			w.save(pointing(hourly), [block(turn("on"), turn("on", lit(FAN)), turn("off"))]);
			await w.advance(HOUR);
			const together = [...w.effects];
			// The lamp's On is not reached at first; its Off must still wait for it.
			let tries = 0;
			w.answer((effect) => (effect === `${PLUG}:on` && tries++ === 0 ? unreachable() : { word: "done" }));
			release();
			await w.automations.settled();
			const beforeRetry = [...w.effects];
			await w.later(60_000);

			expect(together).toEqual([`${PLUG}:on`, `${FAN}:on`]);
			expect(beforeRetry).toEqual(together);
			expect(w.effects).toEqual([`${PLUG}:on`, `${FAN}:on`, `${PLUG}:on`, `${PLUG}:off`]);
		});

		it("lets every branch end before it fails, hands the catch each branch's first failure, and remembers one nothing caught", async () => {
			const w = world();
			w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
			w.save(pointing(hourly), [
				{
					kind: "try",
					steps: [
						block(
							lane(turn("on"), ifttt("skipped")),
							{
								kind: "if",
								when: "true",
								steps: [
									{ kind: "wait", minutes: lit(1) },
									ifttt("late"),
									{ kind: "throw", text: "slow" },
								],
							},
							{ kind: "throw", text: "no" },
						),
						ifttt("unreached"),
					],
					catch: [ifttt("caught", "{e.code} {e.errors.count()} {e.errors[0].message} {e.errors[1].message}")],
				},
				block(turn("on"), ifttt("beside")),
				ifttt("after"),
			]);
			await w.later(HOUR);
			const early = [...w.effects];
			await w.later(60_000);

			// The first lane caught its own refusal; the two throws are listed as written, not as they ended.
			expect(early).toEqual([`${PLUG}:on`]);
			expect(w.effects.slice(1)).toEqual([
				"ifttt:late",
				"ifttt:caught:together 2 slow no",
				`${PLUG}:on`,
				"ifttt:beside",
				"ifttt:after",
			]);
			expect(w.rows().at(-1)).toEqual(["run_function", "refused", CALL_FAILED]);
		});

		it("fails for its own branches alone: a failure the frame already remembers is not a branch's", async () => {
			const w = world();
			w.answer((effect) => (effect.endsWith(":on") ? { word: "refused" } : { word: "done" }));
			w.save(pointing(hourly), [turn("on"), block(ifttt("a"), ifttt("b")), ifttt("after")]);
			await w.later(HOUR);

			expect(w.rows().map(([action, outcome]) => [action, outcome])).toEqual([
				["device_set", "refused"],
				["ifttt_trigger", "ran"],
				["ifttt_trigger", "ran"],
				["ifttt_trigger", "ran"],
				["run_function", "refused"],
			]);
		});

		it("saves an exit beside running steps and a block wider than a run may hold, each as its error", () => {
			const leaves = world().saveOp(pointing(hourly), [block(ifttt("a"), lane({ kind: "exit" }))]);
			const three = () => block(ifttt("a"), ifttt("b"), ifttt("c"));
			const wide = world().saveOp(pointing(hourly), [block(three(), three(), three())]);
			const fits = world().saveOp(pointing(hourly), [block(three(), three(), ifttt("d"), ifttt("e"))]);

			expect(leaves).toMatchObject({ stored: true, issues: [{ level: "error", step: "0.0.1.0.0" }] });
			expect(wide).toMatchObject({ stored: true, issues: [{ level: "error", step: "0" }] });
			expect(fits).toMatchObject({ stored: true });
			expect(fits).not.toHaveProperty("issues");
		});

		it("finds every branch where it stood after a restart: a wait goes on, and a send that was out is not sent again", async () => {
			const w = world();
			const release = w.holdEffects();
			w.save(pointing(hourly), [
				block(ifttt("out"), lane({ kind: "wait", minutes: lit(5) }, ifttt("slow"))),
				ifttt("after"),
			]);
			await w.advance(HOUR);
			const stored = w.state();
			release();
			await w.automations.settled();
			await w.automations.stop();
			// The file as it stood with the send still out.
			fs.writeFileSync(path.join(w.dir, "automation-state.json"), JSON.stringify(stored));
			w.restartWith((rows) => rows);
			await w.later(5 * 60_000);

			expect((stored.fires as { active: string[] }[])[0]?.active).toEqual(["0.0.0.0", "0.0.0.1.0.0"]);
			// From its block's turn the fire holds a key no build before blocks reads, so a rollback drops it whole.
			expect(
				(stored.fires as { frames: Record<string, { strands?: object }> }[])[0]?.frames["0"]?.strands,
			).toEqual({});
			expect(w.effects).toEqual(["ifttt:out", "ifttt:slow", "ifttt:after"]);
			expect(w.rows().map(([action, outcome]) => [action, outcome])).toContainEqual([
				"ifttt_trigger",
				"uncertain",
			]);
		});

		it("refuses a block that would pass a run's cap at its turn, which a save cannot see through a call", async () => {
			const w = world();
			const waits = Array.from({ length: 5 }, () => ({ kind: "wait" as const, minutes: lit(1) }));
			w.automations.save({
				id: "h-wide",
				body: { enabled: false, trigger: hourly, actions: [{ kind: "run_function", function: "wide" }] },
				base: 0,
				function: {
					as: "edit",
					id: "wide",
					body: { name: "Wide", params: [], steps: [block(...waits)] },
					base: 0,
				},
				confirmed: true,
			});
			const saved = w.save(pointing(hourly), [
				block({ kind: "call", function: "wide" }, { kind: "call", function: "wide" }),
				ifttt("after"),
			]);
			await w.later(HOUR);
			await w.later(60_000);

			expect(saved).toMatchObject({ stored: true });
			expect(w.rows().filter(([, , reason]) => reason === TOO_MANY_BESIDE)).toEqual([
				["parallel", "refused", TOO_MANY_BESIDE],
			]);
			expect(w.effects).toEqual(["ifttt:after"]);
		});

		it("serves every step in flight, and lets a run switched off land what is out and start nothing more", async () => {
			const w = world();
			const release = w.holdEffects();
			w.save(pointing(hourly), [block(ifttt("one"), ifttt("two")), ifttt("after")]);
			await w.advance(HOUR);
			const running = w.automations.listing().automations.find((row) => row.id === "warm")?.lastRun;
			w.automations.ownerPut("warm", { ...pointing(hourly), enabled: false }, 1, true);
			release();
			await w.automations.settled();

			expect(running).toMatchObject({ running: true, active: "0.0.0.0", beside: ["0.0.0.0", "0.0.0.1"] });
			expect(w.effects).toEqual(["ifttt:one", "ifttt:two"]);
			expect(w.rows().filter(([action]) => action === "ifttt_trigger")).toHaveLength(2);
		});

		it("runs a function a branch calls as part of that branch, and ends only the branch at its throw", async () => {
			const w = world();
			w.automations.save({
				id: "h-inner",
				body: { enabled: false, trigger: hourly, actions: [{ kind: "run_function", function: "inner" }] },
				base: 0,
				function: {
					as: "edit",
					id: "inner",
					body: { name: "Inner", params: [], steps: [ifttt("inner"), { kind: "exit" }, ifttt("never")] },
					base: 0,
				},
				confirmed: true,
			});
			w.save(pointing(hourly), [
				block(
					{ kind: "call", function: "inner" },
					lane({ kind: "throw", text: "stop" }, ifttt("unreached")),
					ifttt("beside"),
				),
				ifttt("after"),
			]);
			await w.later(HOUR);

			expect(w.effects.sort()).toEqual(["ifttt:after", "ifttt:beside", "ifttt:inner"]);
		});
	});
});

describe("a script saved with errors", () => {
	const unparsed = { kind: "unparsed" as const, source: 'devices.set(room, "on"' };

	it("keeps its text as the function's one step, stays armed, and fails each run there, which a caller's try catches", async () => {
		const w = world();
		const saved = w.save(pointing(hourly), [unparsed]);
		const row = w.automations.listing().automations.find((held) => held.id === "warm");
		await w.later(HOUR);
		const alone = w.rows();

		w.automations.save({
			id: "h-inner",
			body: { enabled: false, trigger: hourly, actions: [{ kind: "run_function", function: "inner" }] },
			base: 0,
			function: { as: "edit", id: "inner", body: { name: "Inner", params: [], steps: [unparsed] }, base: 0 },
			confirmed: true,
		});
		w.save(
			pointing(hourly),
			[
				{ kind: "try", steps: [{ kind: "call", function: "inner" }], catch: [ifttt("caught", "{e.code}")] },
				ifttt("after"),
			],
			{ automation: 1, function: 1 },
		);
		await w.later(HOUR);

		expect(saved.stored).toBe(true);
		expect(row?.invalid).toBeUndefined();
		expect(alone).toEqual([
			["unparsed", "refused", SCRIPT_ERRORS],
			["run_function", "refused", CALL_FAILED],
		]);
		expect(w.effects).toEqual(["ifttt:caught:call_failed", "ifttt:after"]);
	});

	it("refuses at the save a script with errors beside another step or inside a block", () => {
		const said = (steps: AutomationFunctionInput["steps"]) => {
			const saved = world().save(pointing(hourly), steps);
			return saved.stored ? "stored" : saved.reason;
		};

		expect([
			said([unparsed, ifttt("x")]),
			said([{ kind: "try", steps: [unparsed], catch: [] }]),
			said([unparsed]),
		]).toEqual([UNPARSED_ALONE, UNPARSED_ALONE, "stored"]);
	});
});
