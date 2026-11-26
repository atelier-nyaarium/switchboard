import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeAutomations } from "../gateway/compose/composeAutomations.js";
import { QUEUE_FULL, QUEUE_MAX_EVENTS } from "../gateway/computed/automationOutbox.js";
import { CALL_FAILED } from "../gateway/computed/automationPass.js";
import type { Attempt } from "../gateway/computed/automationRunner.js";
import {
	type AutomationHoles,
	CONDITION_UNREAD,
	NEWER_SET,
	NOT_TRUE_OR_FALSE,
	STEP_UNFIT,
	THROWN,
	VALUE_TOO_LARGE,
	VALUE_UNREAD,
} from "../gateway/computed/automations.js";
import { FUNCTION_GONE, FUNCTION_UNREAD, NO_SWITCH } from "../gateway/computed/automationValidity.js";
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
		later,
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

	it("refuses an unsound body where it is written, read, entered and run", async () => {
		const w = world();
		const written = w.save(pointing(event), [turn("on", lit("aa:bb:cc:dd:ee:99"))]);
		w.save(pointing(event, { keepTryingMin: 60 }), [turn("on", lit(PLUG)), turn("on", lit(FAN))]);
		await w.queueTwo();
		w.unplug(FAN);
		const read = w.automations.invalidOf("warm");
		w.answer(() => ({ word: "done" }));
		await w.later(60_000);

		expect([written.stored, read]).toEqual([false, NO_SWITCH]);
		expect(w.effects).toEqual([`${PLUG}:on`, `${PLUG}:on`]);
		expect(w.rows()).toEqual([
			["device_set", "ran", undefined],
			["device_set", "refused", NO_SWITCH],
			["run_function", "refused", CALL_FAILED],
			["run_function", "refused", NO_SWITCH],
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

	it("refuses at the save a name already taken, a wait out of range, and a condition it cannot read, at any depth", () => {
		const bodies: AutomationFunctionInput["steps"][] = [
			[{ kind: "let", name: "room", value: lit(1) }],
			[{ kind: "wait", minutes: lit(-1) }],
			[{ kind: "wait", minutes: lit(2_000) }],
			[{ kind: "if", when: "nobody > 1" }],
			[{ kind: "try", steps: [{ kind: "if", when: "(", steps: [turn("on")] }], catch: [] }],
			[{ kind: "if", when: "true", else: [{ kind: "throw", text: "{nobody}" }] }],
			[{ kind: "if", when: "true} ignored {false", steps: [turn("on")] }],
			[turn("on", expr("room} {room"))],
		];

		expect(bodies.map((steps) => world().save(pointing(hourly), steps).stored)).toEqual(bodies.map(() => false));
	});

	it("names the step a save was refused for by its numbers, at any depth", () => {
		const bodies: AutomationFunctionInput["steps"][] = [
			[{ kind: "if", when: "true", steps: [{ kind: "throw", text: "{nobody}" }] }],
			[{ kind: "try", steps: [turn("on")], catch: [turn("on"), { kind: "wait", minutes: lit(-1) }] }],
			[turn("on"), { kind: "if", when: "true", else: [{ kind: "let", name: "room", value: lit(1) }] }],
			[turn("on"), ifttt("bell", "{nobody}")],
		];
		const refused = bodies.map((steps) => {
			const saved = world().save(pointing(hourly), steps);
			const refusal = saved.stored ? undefined : saved.refusal;
			return [refusal?.code, refusal?.step, refusal?.param];
		});

		expect(refused).toEqual([
			["hole", "0.0.0", "text"],
			["invalid", "0.1.1", "minutes"],
			["invalid", "1.1.0", "name"],
			["hole", "1", "value1"],
		]);
	});

	it("refuses a body nested past its depth or holding too many steps", () => {
		const nest = (depth: number): AutomationFunctionInput["steps"] =>
			depth === 0 ? [{ kind: "exit" }] : [{ kind: "if", when: "true", steps: nest(depth - 1) }];
		const wide = (lists: number): AutomationFunctionInput["steps"] =>
			Array.from({ length: lists }, () => ({
				kind: "if" as const,
				when: "true",
				steps: Array.from({ length: 8 }, () => ({ kind: "exit" as const })),
			}));
		const parses = (steps: AutomationFunctionInput["steps"]) =>
			FunctionSchema.safeParse({ name: "Deep", params: [], steps }).success;

		expect([nest(3), nest(4), wide(3), wide(4)].map(parses)).toEqual([true, false, true, false]);
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
});
