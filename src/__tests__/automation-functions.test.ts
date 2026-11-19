import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import type { SavedFunction } from "../gateway/computed/automationJudge.js";
import { FUNCTION_UNREAD } from "../gateway/computed/automationValidity.js";
import { unknown } from "../shared/expressions.js";
import type { AutomationInput, AutomationTrigger } from "../shared/schemasAutomation.js";
import type { AutomationFunctionInput } from "../shared/schemasFunction.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PLUG = "aa:bb:cc:dd:ee:01";
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
function open(home = true, seed: object[] = []) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-functions-"));
	roots.push(dir);
	if (seed.length > 0) fs.writeFileSync(path.join(dir, "automations.json"), JSON.stringify(seed));
	let n = 0;
	let atHome = home;
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
			actions: {
				ready: () => true,
				switchName: (device) => (device === PLUG ? "Lamp" : null),
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
	return { automations, save, functions, leave: () => (atHome = false) };
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
			{ code: "unknown_function", id: "later" },
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
