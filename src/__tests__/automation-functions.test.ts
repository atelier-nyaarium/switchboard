import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import type { SavedFunction } from "../gateway/computed/automationJudge.js";
import { FUNCTION_UNREAD, NO_SWITCH } from "../gateway/computed/automationValidity.js";
import { evaluateHole, fillHoles, holeIssue } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { unknown } from "../shared/expressions.js";
import type { AutomationInput, AutomationTrigger } from "../shared/schemasAutomation.js";
import type { AutomationFunctionInput, StepArg } from "../shared/schemasFunction.js";

const REGISTRY = createConsoleRegistry([]);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PLUG = "aa:bb:cc:dd:ee:01";
const LAMP = "aa:bb:cc:dd:ee:02";
const event: AutomationTrigger = { kind: "event", source: "github", conditions: [] };
const hourly: AutomationTrigger = { kind: "interval", everyMin: 60 };

const lit = (value: string | number) => ({ kind: "literal" as const, value });
const tell = { kind: "do", action: "tell_assistant", args: { when: lit("now") } } as const;
const on = {
	kind: "do",
	action: "device_set",
	args: { device: { kind: "expression", text: "room" }, verb: lit("on") },
} as const;
const bell = { kind: "do", action: "ifttt_trigger", args: { event: lit("bell") } } as const;

const fn = (steps: AutomationFunctionInput["steps"], params: AutomationFunctionInput["params"] = []) => ({
	name: "Warm up",
	params,
	steps,
});
const room = [{ name: "room", type: "device" as const }];

const pointing = (
	trigger: AutomationTrigger,
	function_: string,
	values: Record<string, string | number> = {},
): AutomationInput => ({
	enabled: true,
	trigger,
	actions: [{ kind: "run_function", function: function_, values }],
});

/** `seed`: records as a file already holds them. */
function open(home = true, seed: object[] = [], keyFile?: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-functions-"));
	roots.push(dir);
	if (seed.length > 0) fs.writeFileSync(path.join(dir, "automations.json"), JSON.stringify(seed));
	if (keyFile !== undefined) fs.writeFileSync(path.join(dir, "automation-function-key.json"), keyFile);
	let n = 0;
	let atHome = home;
	const switches = new Set([PLUG, LAMP]);
	const { automations } = openAutomationPair({
		dataDir: dir,
		newIncarnation: () => `a${++n}`,
		now: () => 1_000,
		input: () => ({ type: { type: "number", integral: false }, value: unknown("not heard") }),
		automations: {
			isHome: () => atHome,
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
				switchName: (device) => (switches.has(device) ? "Lamp" : null),
				deviceSet: async () => ({ word: "done" }),
				iftttTrigger: async () => ({ word: "done" }),
			},
		},
	});
	const save = (id: string, body: AutomationInput, base: number, fn_?: SavedFunction, confirmed = true) =>
		automations.save({ id, body, base, ...(fn_ ? { function: fn_ } : {}), confirmed });
	const functions = () =>
		(JSON.parse(fs.readFileSync(path.join(dir, "automations.json"), "utf8")) as { id: string; kind: string }[])
			.filter((row) => row.kind === "function")
			.map((row) => row.id)
			.sort();
	return {
		automations,
		save,
		functions,
		dir,
		leave: () => (atHome = false),
		unplug: (device = PLUG) => switches.delete(device),
	};
}

const refusalOf = (saved: ReturnType<ReturnType<typeof open>["save"]>) => (saved.stored ? null : saved.refusal);

describe("an automation that runs a function", () => {
	it("lands with a new function in one write, and names the record that moved when either is stale", () => {
		const { automations, save, functions } = open();
		const first = save("warm", pointing(hourly, "warm-up", { room: PLUG }), 0, {
			as: "edit",
			id: "warm-up",
			body: fn([on], room),
			base: 0,
		});
		const staleFunction = save("warm", pointing(hourly, "warm-up", { room: PLUG }), 1, {
			as: "edit",
			id: "warm-up",
			body: fn([on, tell], room),
			base: 0,
		});
		const staleAutomation = save("warm", { ...pointing(hourly, "warm-up", { room: PLUG }), label: "Warm" }, 0, {
			as: "edit",
			id: "warm-up",
			body: fn([on, tell], room),
			base: 1,
		});

		expect(first).toMatchObject({ stored: true, automation: { revision: 1 }, function: { revision: 1 } });
		expect([refusalOf(staleFunction), refusalOf(staleAutomation)]).toEqual([
			{ code: "moved", record: "function", revision: 1 },
			{ code: "moved", record: "automation", revision: 1 },
		]);
		expect([automations.list().map((row) => row.revision), functions()]).toEqual([[1], ["warm-up"]]);
	});

	it("refuses a pointer beside other actions, a flat put from an older phone over a pointer, a function it does not hold, and a second cool-down", () => {
		const { automations, save } = open();
		save("warm", pointing(hourly, "warm-up", { room: PLUG }), 0, {
			as: "edit",
			id: "warm-up",
			body: fn([on], room),
			base: 0,
		});
		const mixed = save(
			"mixed",
			{
				...pointing(hourly, "warm-up"),
				actions: [
					{ kind: "run_function", function: "warm-up", values: { room: PLUG } },
					{ kind: "tell_assistant", when: "now" },
				],
			},
			0,
		);
		const flat = automations.ownerPut(
			"warm",
			{ enabled: true, trigger: hourly, actions: [{ kind: "tell_assistant", when: "now" }] },
			1,
		);
		const gone = save("lost", pointing(hourly, "nowhere"), 0);
		const taken = save("warm-up", pointing(hourly, "warm-up", { room: PLUG }), 0);
		const takenBy = save("same", pointing(hourly, "same"), 0, {
			as: "edit",
			id: "same",
			body: fn([tell]),
			base: 0,
		});
		const crossing: AutomationTrigger = {
			kind: "crossing",
			device: PLUG,
			measure: "temperature",
			direction: "above",
			threshold: 1,
			deadZone: 1,
			coolDownSec: 0,
		};
		const twice = save(
			"twice",
			{
				...pointing(crossing, "warm-up", { room: PLUG }),
				actions: [{ kind: "run_function", function: "warm-up", values: { room: PLUG }, coolDownSec: 60 }],
			},
			0,
		);

		expect([refusalOf(mixed)?.code, flat.stored, refusalOf(gone), refusalOf(twice)?.code]).toEqual([
			"mixed",
			false,
			{ code: "unknown_function", id: "nowhere" },
			"cool_down_twice",
		]);
		expect([refusalOf(taken), refusalOf(takenBy)]).toEqual([
			{ code: "invalid", record: "automation", id: "warm-up" },
			{ code: "invalid", record: "function", id: "same" },
		]);
	});

	it("refuses an edit that stops another user fitting, and lets a toggle through whatever it fits", () => {
		const { automations, save } = open();
		save("a", pointing(hourly, "warm-up", { room: PLUG }), 0, {
			as: "edit",
			id: "warm-up",
			body: fn([on], room),
			base: 0,
		});
		save("b", pointing(hourly, "warm-up", { room: PLUG }), 0);
		const degrees = [...room, { name: "degrees", type: "number" as const }];

		const widened = save("a", pointing(hourly, "warm-up", { room: PLUG, degrees: 21 }), 1, {
			as: "edit",
			id: "warm-up",
			body: fn([on], degrees),
			base: 1,
		});
		const unset = save("c", pointing(hourly, "warm-up"), 0);

		expect([refusalOf(widened), refusalOf(unset), automations.list().length]).toEqual([
			{ code: "unfit", automations: ["b"] },
			{ code: "unfit", automations: ["c"] },
			2,
		]);
	});

	it("reads an automation whose function a newer build wrote as invalid with its own line, and points nothing new at it", () => {
		const row = (id: string, kind: string, body: object) => ({ id, kind, revision: 1, incarnation: id, body });
		const { automations, save } = open(true, [
			row("later", "function", { name: "Later", params: [], steps: [{ kind: "wait", minutes: 5 }] }),
			row("x", "automation", pointing(hourly, "later")),
		]);

		expect([automations.invalidOf("x"), refusalOf(save("y", pointing(hourly, "later"), 0))]).toEqual([
			FUNCTION_UNREAD,
			{ code: "newer_function", record: "function", id: "later" },
		]);
	});

	it("lets a toggle through on an automation that no longer fits, and refuses any other edit of it", () => {
		const row = (id: string, kind: string, body: object) => ({ id, kind, revision: 1, incarnation: id, body });
		const degrees = [...room, { name: "degrees", type: "number" as const }];
		const { automations, save } = open(true, [
			row("warm-up", "function", fn([on], degrees)),
			row("d", "automation", pointing(hourly, "warm-up", { room: PLUG })),
		]);

		const toggled = automations.ownerPut(
			"d",
			{ ...pointing(hourly, "warm-up", { room: PLUG }), enabled: false },
			1,
		);
		const relabelled = save("d", { ...pointing(hourly, "warm-up", { room: PLUG }), enabled: false, label: "D" }, 2);

		expect([toggled.stored, refusalOf(relabelled)]).toEqual([true, { code: "unfit", automations: ["d"] }]);
	});

	it("asks once for every user an edit newly reaches outside, and for a dangerous step whatever triggers it", () => {
		const { save } = open();
		save(
			"told",
			pointing(event, "steps", { room: PLUG }),
			0,
			{ as: "edit", id: "steps", body: fn([tell], room), base: 0 },
			false,
		);
		save("clock", pointing(hourly, "steps", { room: PLUG }), 0, undefined, false);

		const reach = save(
			"clock",
			pointing(hourly, "steps", { room: PLUG }),
			1,
			{ as: "edit", id: "steps", body: fn([tell, on], room), base: 1 },
			false,
		);
		const confirmed = save("clock", pointing(hourly, "steps", { room: PLUG }), 1, {
			as: "edit",
			id: "steps",
			body: fn([tell, on], room),
			base: 1,
		});
		const again = save(
			"clock",
			pointing(hourly, "steps", { room: PLUG }),
			1,
			{ as: "edit", id: "steps", body: fn([on, tell], room), base: 2 },
			false,
		);
		const danger = save(
			"clock",
			pointing(hourly, "steps", { room: PLUG }),
			1,
			{ as: "edit", id: "steps", body: fn([on, tell, bell], room), base: 3 },
			false,
		);

		expect([refusalOf(reach), confirmed.stored, again.stored, refusalOf(danger)]).toEqual([
			{ code: "confirm", labels: ["Switch a plug"] },
			true,
			true,
			{ code: "confirm", labels: ["Send to IFTTT"] },
		]);
	});

	it("writes a function an event automation runs only at the assistant's home", () => {
		const { save, leave } = open();
		save("told", pointing(event, "steps"), 0, { as: "edit", id: "steps", body: fn([tell]), base: 0 });
		save("clock", pointing(hourly, "steps"), 0);
		leave();

		const away = save("clock", pointing(hourly, "steps"), 1, {
			as: "edit",
			id: "steps",
			body: fn([tell, tell]),
			base: 1,
		});
		const local = save("own", pointing(hourly, "own-steps"), 0, {
			as: "edit",
			id: "own-steps",
			body: fn([tell]),
			base: 0,
		});

		expect([refusalOf(away), local.stored]).toEqual([{ code: "not_home" }, true]);
	});

	it("removes a function once its last user leaves it, and keeps one another automation still runs", () => {
		const { automations, save, functions } = open();
		save("a", pointing(hourly, "shared"), 0, { as: "edit", id: "shared", body: fn([tell]), base: 0 });
		save("b", pointing(hourly, "shared"), 0);
		save("c", pointing(hourly, "alone"), 0, { as: "edit", id: "alone", body: fn([tell]), base: 0 });

		save("a", { enabled: true, trigger: hourly, actions: [{ kind: "tell_assistant", when: "now" }] }, 1);
		const kept = functions();
		automations.ownerRemove("b", 1);
		save("c", pointing(hourly, "fresh"), 1, { as: "edit", id: "fresh", body: fn([tell]), base: 0 });

		expect([kept, functions()]).toEqual([["alone", "shared"], ["fresh"]]);
	});

	it("counts an automation it cannot read as a user, deleting no function while one is held", () => {
		const row = (id: string, kind: string, body: object) => ({ id, kind, revision: 1, incarnation: id, body });
		const runs = [{ kind: "run_function", function: "shared" }];
		const { automations, functions } = open(true, [
			row("shared", "function", fn([tell])),
			row("later", "automation", { enabled: true, trigger: { kind: "geofence", place: "home" }, actions: runs }),
			row("mine", "automation", { enabled: true, trigger: hourly, actions: runs }),
		]);

		const removed = automations.ownerRemove("mine", 1);
		const swept = automations.write({ kind: "sweep", ids: ["shared"] });

		expect([removed.deleted, swept.written]).toEqual([true, true]);
		expect(functions()).toEqual(["shared"]);
	});

	describe("a function's steps, checked as a flat action is", () => {
		const step = (args: Record<string, StepArg>, action = "device_set") => ({ kind: "do", action, args }) as const;
		const saveWith = (steps: AutomationFunctionInput["steps"], values: Record<string, string> = { room: PLUG }) => {
			const { save } = open();
			return save("warm", pointing(hourly, "warm-up", values), 0, {
				as: "edit",
				id: "warm-up",
				body: fn(steps, room),
				base: 0,
			});
		};

		it("refuses a hole outside a text, a value its action does not take, a choice it does not offer, and a plug it does not hold", () => {
			const refused = [
				saveWith([step({ device: lit("{room}"), verb: lit("on") })]),
				saveWith([step({ device: lit(PLUG), verb: lit("on"), colour: lit("red") })]),
				saveWith([step({ device: lit(PLUG), verb: lit("sideways") })]),
				saveWith([step({ device: lit("aa:bb:cc:dd:ee:99"), verb: lit("on") })]),
				saveWith([on], { room: "aa:bb:cc:dd:ee:99" }),
			].map(refusalOf);

			expect(refused).toEqual([
				{ code: "hole", record: "function", path: "0", param: "device", start: 0, end: 6 },
				{ code: "invalid", record: "function", path: "steps.0.colour" },
				{ code: "invalid", record: "function", path: "steps.0.verb" },
				{ code: "invalid", record: "function", path: "steps.0.device" },
				{ code: "invalid", record: "automation", path: "values.room" },
			]);
		});

		it("lets an edit of a shared function through when another user's plug went before it", () => {
			const { save, unplug } = open();
			save("a", pointing(hourly, "warm-up", { room: PLUG }), 0, {
				as: "edit",
				id: "warm-up",
				body: fn([on], room),
				base: 0,
			});
			save("b", pointing(hourly, "warm-up", { room: LAMP }), 0);
			unplug(LAMP);
			const renamed = save("a", pointing(hourly, "warm-up", { room: PLUG }), 1, {
				as: "edit",
				id: "warm-up",
				body: { ...fn([on], room), name: "Warm up, renamed" },
				base: 1,
			});

			expect(renamed.stored).toBe(true);
		});

		it("reads an automation invalid once the plug its value names goes", () => {
			const { save, automations, unplug } = open();
			save("warm", pointing(hourly, "warm-up", { room: PLUG }), 0, {
				as: "edit",
				id: "warm-up",
				body: fn([on], room),
				base: 0,
			});
			const before = automations.invalidOf("warm");
			unplug();

			expect([before, automations.invalidOf("warm")]).toEqual([null, NO_SWITCH]);
		});

		it("lets a function read an event's link and id, as the fire gives them", () => {
			const { save } = open();
			const linked = save("linked", pointing(event, "linked-fn"), 0, {
				as: "edit",
				id: "linked-fn",
				body: fn([step({ when: lit("now"), message: lit("See {event.url} ({event.id})") }, "tell_assistant")]),
				base: 0,
			});

			expect(linked.stored).toBe(true);
		});
	});

	it("asks nothing again when a flat automation's dangerous action becomes a function's step", () => {
		const { save } = open();
		const flat: AutomationInput = {
			enabled: true,
			trigger: hourly,
			actions: [{ kind: "ifttt_trigger", event: "bell" }],
		};
		save("x", flat, 0);
		const named = save(
			"x",
			pointing(hourly, "ring"),
			1,
			{ as: "edit", id: "ring", body: fn([bell]), base: 0 },
			false,
		);

		expect(named.stored).toBe(true);
	});

	describe("make unique", () => {
		const copyOf = (body: AutomationFunctionInput) => ({ as: "copy", from: "shared", fromBase: 1, body }) as const;
		const saved = (result: ReturnType<ReturnType<typeof open>["save"]>) =>
			result.stored ? (result.function?.id ?? null) : null;

		it("never writes over a copy another automation runs, and mints again once its copy was removed", () => {
			const { save, functions } = open();
			save("a", pointing(hourly, "shared"), 0, { as: "edit", id: "shared", body: fn([tell]), base: 0 });
			save("b", pointing(hourly, "shared"), 0);
			save("keeps", pointing(hourly, "shared"), 0);
			const first = saved(save("a", pointing(hourly, "shared"), 1, copyOf(fn([tell, tell]))));
			save("b", pointing(hourly, first ?? ""), 1);
			save("a", pointing(hourly, "shared"), 2);
			const second = saved(save("a", pointing(hourly, "shared"), 3, copyOf(fn([bell]))));
			save("b", pointing(hourly, "shared"), 2);
			save("a", pointing(hourly, "shared"), 4);
			const third = saved(save("a", pointing(hourly, "shared"), 5, copyOf(fn([bell]))));

			expect(first).not.toBeNull();
			expect(second === first || second === null).toBe(false);
			expect(third).toBe(first);
			expect(functions()).toEqual([first, "shared"].sort());
		});

		it("answers a retry whose answer was lost as stored, though the source is gone", () => {
			const { save, functions } = open();
			save("a", pointing(hourly, "shared"), 0, { as: "edit", id: "shared", body: fn([tell]), base: 0 });
			const made = save("a", pointing(hourly, "shared"), 1, copyOf(fn([tell, tell])));
			const retried = save("a", pointing(hourly, "shared"), 1, copyOf(fn([tell, tell])));

			expect([saved(made), saved(retried)]).toEqual([saved(made), saved(made)]);
			expect(functions()).toEqual([saved(made)]);
		});

		it("refuses a copy with a coded refusal when the key file cannot be read, and leaves the file as it was", () => {
			const { save, dir } = open(true, [], "{ not json");
			save("a", pointing(hourly, "shared"), 0, { as: "edit", id: "shared", body: fn([tell]), base: 0 });
			const copied = save("a", pointing(hourly, "shared"), 1, copyOf(fn([tell, tell])));

			expect(refusalOf(copied)).toEqual({ code: "no_key" });
			expect(fs.readFileSync(path.join(dir, "automation-function-key.json"), "utf8")).toBe("{ not json");
		});
	});

	it("names each store refusal by its own code: the total cap, a kind's cap, and a row a newer build holds", () => {
		const row = (id: string, kind: string, body: object) => ({ id, kind, revision: 1, incarnation: id, body });
		const flat = { enabled: true, trigger: hourly, actions: [{ kind: "tell_assistant", when: "now" }] };
		const atTotal = open(
			true,
			Array.from({ length: 64 }, (_, at) => row(`f${at}`, "automation", flat)),
		);
		const atFunctions = open(
			true,
			Array.from({ length: 32 }, (_, at) => row(`fn${at}`, "function", fn([tell]))),
		);
		const newer = open(true, [
			row("later", "automation", { enabled: true, trigger: { kind: "geofence" }, actions: [] }),
		]);

		expect([
			refusalOf(atTotal.save("one-more", flat as AutomationInput, 0)),
			refusalOf(
				atFunctions.save("a", pointing(hourly, "fresh"), 0, {
					as: "edit",
					id: "fresh",
					body: fn([tell]),
					base: 0,
				}),
			),
			refusalOf(newer.save("later", flat as AutomationInput, 0)),
		]).toEqual([
			{ code: "full", max: 64 },
			{ code: "full", kind: "function", max: 32 },
			{ code: "newer_automation", id: "later" },
		]);
	});

	it("repoints to a new function at the cap, the old one's removal making the room", () => {
		const row = (id: string, kind: string, body: object) => ({ id, kind, revision: 1, incarnation: id, body });
		const flat = { enabled: true, trigger: hourly, actions: [{ kind: "tell_assistant", when: "now" }] };
		const { save, functions } = open(true, [
			...Array.from({ length: 62 }, (_, at) => row(`f${at}`, "automation", flat)),
			row("old", "function", fn([tell])),
			row("x", "automation", pointing(hourly, "old")),
		]);

		const moved = save("x", pointing(hourly, "new"), 1, { as: "edit", id: "new", body: fn([tell]), base: 0 });

		expect(moved.stored).toBe(true);
		expect(functions()).toEqual(["new"]);
	});

	it("names a copy under the Gateway's key, the same for a retried save and another for another automation", () => {
		const { save, functions } = open();
		save("a", pointing(hourly, "shared"), 0, { as: "edit", id: "shared", body: fn([tell]), base: 0 });
		save("b", pointing(hourly, "shared"), 0);

		const copy = { as: "copy", from: "shared", fromBase: 1, body: fn([tell, tell]) } as const;
		const made = save("b", pointing(hourly, "shared"), 1, copy);
		const retried = save("b", pointing(hourly, "shared"), 1, copy);
		const other = save("a", pointing(hourly, "shared"), 1, copy);

		const ids = [made, retried, other].map((saved) => (saved.stored ? saved.function?.id : null));
		expect(ids[0]).toMatch(/^fn-[0-9a-f]{16}$/);
		expect([ids[1] === ids[0], ids[2] === ids[0]]).toEqual([true, false]);
		expect(functions()).toEqual([ids[0], ids[2]].sort());
	});
});
