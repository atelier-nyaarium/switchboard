import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import {
	type AutomationIntent,
	type AutomationJudgeView,
	judgeAutomationWrite,
	type SavedFunction,
} from "../gateway/computed/automationJudge.js";
import { FUNCTION_UNREAD, NO_SWITCH } from "../gateway/computed/automationValidity.js";
import { holesOver } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import type { OwnerRecord } from "../gateway/ownerRecords.js";
import { unknown } from "../shared/expressions.js";
import {
	type Automation,
	type AutomationInput,
	AutomationSchema,
	type AutomationTrigger,
} from "../shared/schemasAutomation.js";
import {
	AUTOMATION_SAVE_REFUSALS,
	type AutomationSaveRefusalCode,
	SAVE_LINE_MAX,
} from "../shared/schemasAutomationSave.js";
import { type AutomationFunctionInput, FunctionSchema, type StepArg } from "../shared/schemasFunction.js";

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
			holes: () => holesOver(REGISTRY),
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

const refusalOf = (saved: ReturnType<ReturnType<typeof open>["save"]>) => {
	if (saved.stored) return null;
	const refusal = { ...saved.refusal };
	delete refusal.line;
	return refusal;
};

describe("a save that changes who owns a function", () => {
	const record = <T>(id: string, kind: string, revision: number, body: T): OwnerRecord<T> => ({
		id,
		kind,
		revision,
		incarnation: id,
		body,
	});
	const pointer = pointing(hourly, "fn");
	const view = (patch: Partial<AutomationJudgeView> = {}): AutomationJudgeView => ({
		held: [record("warm", "automation", 1, AutomationSchema.parse(pointer))],
		functions: [record("fn", "function", 2, FunctionSchema.parse({ ...fn([tell]), name: "Shared" }))],
		unreadAutomations: 0,
		unreadFunctions: 0,
		isHome: true,
		assess: () => [],
		copyIdOf: () => "copy-0",
		carryIdOf: () => "carry-0",
		unreadAt: () => false,
		unreadFunctionAt: () => false,
		...patch,
	});
	const codeOf = (intent: AutomationIntent, held: AutomationJudgeView) => {
		const verdict = judgeAutomationWrite(intent, held);
		return verdict.kind === "refused" ? verdict.refusal.code : "written";
	};
	const flat = { ...pointer, actions: [{ kind: "tell_assistant" as const, when: "now" as const }] };

	it("flattens only the function revision the screen showed", () => {
		const flatten = (functionBase: number): AutomationIntent => ({
			kind: "save",
			id: "warm",
			body: flat,
			base: 1,
			functionBase,
			confirmed: true,
		});

		expect([codeOf(flatten(1), view()), codeOf(flatten(2), view())]).toEqual(["moved", "written"]);
	});

	it("makes no function unnamed while an unread row may run it", () => {
		const clear: AutomationIntent = {
			kind: "save",
			id: "warm",
			body: pointer,
			base: 1,
			function: { as: "edit", id: "fn", base: 2, body: { ...fn([tell]), name: "" } },
			confirmed: true,
		};

		expect([codeOf(clear, view()), codeOf(clear, view({ unreadAutomations: 1 }))]).toEqual(["written", "private"]);
	});

	it("points nothing new at an unnamed function while an unread row may run it", () => {
		const own = record("own", "function", 1, FunctionSchema.parse({ ...fn([tell]), name: "" }));
		const ownedBy = (id: string) => [record(id, "automation", 1, AutomationSchema.parse(pointing(hourly, "own")))];
		const point: AutomationIntent = {
			kind: "save",
			id: "ring",
			body: pointing(hourly, "own"),
			base: 0,
			confirmed: true,
		};
		const edit: AutomationIntent = {
			kind: "save",
			id: "warm",
			body: pointing(hourly, "own"),
			base: 1,
			function: { as: "edit", id: "own", base: 1, body: { ...fn([tell, tell]), name: "" } },
			confirmed: true,
		};

		expect([
			codeOf(point, view({ held: [], functions: [own] })),
			codeOf(point, view({ held: [], functions: [own], unreadAutomations: 1 })),
		]).toEqual(["written", "private"]);
		expect(codeOf(edit, view({ held: ownedBy("warm"), functions: [own], unreadAutomations: 1 }))).toBe("written");
	});
});

describe("save refusal lines", () => {
	it("gives every judge refusal a bounded sentence", () => {
		const record = <T>(id: string, kind: string, body: T): OwnerRecord<T> => ({
			id,
			kind,
			revision: 1,
			incarnation: id,
			body,
		});
		const automationRecord = (id: string, body: AutomationInput): OwnerRecord<Automation> =>
			record(id, "automation", AutomationSchema.parse(body));
		const view = (patch: Partial<AutomationJudgeView> = {}): AutomationJudgeView => ({
			held: [],
			functions: [],
			unreadAutomations: 0,
			unreadFunctions: 0,
			isHome: true,
			assess: () => [],
			copyIdOf: () => "copy-0",
			carryIdOf: () => "carry-0",
			unreadAt: () => false,
			unreadFunctionAt: () => false,
			...patch,
		});
		const saveIntent = (
			id: string,
			body: unknown,
			options: Partial<Omit<Extract<AutomationIntent, { kind: "save" }>, "kind" | "id" | "body">> = {},
		): AutomationIntent => ({ kind: "save", id, body, base: 0, confirmed: false, ...options });
		const refusal = (intent: AutomationIntent, held: AutomationJudgeView) => {
			const verdict = judgeAutomationWrite(intent, held);
			if (verdict.kind !== "refused") throw new Error("expected refusal");
			return verdict.refusal;
		};
		const savedFunction = record("fn", "function", FunctionSchema.parse(fn([tell])));
		const functionPointer = (id = "fn") => ({ kind: "run_function" as const, function: id });
		const badFunction = {
			as: "edit" as const,
			id: "fn",
			base: 0,
			body: { name: "Bad", params: [], steps: [{ kind: "wait", minutes: 1 }] },
		};
		const copyBody = FunctionSchema.parse(fn([tell]));
		const copyIntent = (from = "source") =>
			saveIntent("copy-job", pointing(hourly, from), {
				function: { as: "copy", from, fromBase: 1, body: copyBody },
			});
		const source = record("source", "function", copyBody);
		const eventReach: AutomationInput = {
			enabled: true,
			trigger: event,
			actions: [{ kind: "device_set", device: PLUG, verb: "on" }],
		};
		const refusals = [
			refusal(saveIntent("bad", pointing(hourly, "fn"), { function: badFunction }), view()),
			refusal(
				saveIntent("mixed", {
					...pointing(hourly, "fn"),
					actions: [functionPointer(), { kind: "tell_assistant", when: "now" }],
				}),
				view(),
			),
			refusal(
				{
					kind: "owner_put",
					id: "old",
					body: { ...pointing(hourly, "fn"), actions: [{ kind: "tell_assistant", when: "now" }] },
					base: 1,
				},
				view({ held: [automationRecord("old", pointing(hourly, "fn"))] }),
			),
			refusal(copyIntent("missing"), view()),
			refusal(saveIntent("later", pointing(hourly, "later")), view({ unreadAt: (id) => id === "later" })),
			refusal(saveIntent("gone", pointing(hourly, "gone")), view()),
			refusal(
				saveIntent("unfit", pointing(hourly, "fn")),
				view({
					functions: [savedFunction],
					assess: () => [{ at: "fit", function: "fn", issue: { kind: "unfit" } }],
				}),
			),
			refusal(saveIntent("away", { ...eventReach }, { confirmed: true }), view({ isHome: false })),
			refusal(saveIntent("reach", eventReach), view()),
			refusal(copyIntent(), view({ copyIdOf: () => null })),
			refusal(
				copyIntent(),
				view({
					functions: [source],
					copyIdOf: (_automationId, id) =>
						id === "source" ? "copy-0" : `copy-${Number(id.slice("copy-".length)) + 1}`,
					unreadAt: (id) => id.startsWith("copy-"),
				}),
			),
		];
		const judgeCodes = new Set<AutomationSaveRefusalCode>([
			"gone",
			"invalid",
			"unfit",
			"unknown_function",
			"mixed",
			"newer_app",
			"not_home",
			"confirm",
			"newer_function",
			"no_key",
			"no_free_id",
		]);

		expect(refusals.map((held) => held.code).sort()).toEqual(
			AUTOMATION_SAVE_REFUSALS.filter((code) => judgeCodes.has(code)).sort(),
		);
		expect(
			refusals.every(
				(held) => held.line !== undefined && held.line.length > 0 && held.line.length <= SAVE_LINE_MAX,
			),
		).toBe(true);
	});
});

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
			{ code: "moved", record: "function", id: "warm-up", revision: 1 },
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
		expect([refusalOf(mixed)?.code, flat.stored, refusalOf(gone)]).toEqual([
			"mixed",
			false,
			{ code: "unknown_function", id: "nowhere" },
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

	it("points nothing new at a function whose own step no longer holds, and leaves its user to edit and toggle", () => {
		const { automations, save, unplug } = open();
		const literal = { kind: "do", action: "device_set", args: { device: lit(PLUG), verb: lit("on") } } as const;
		save("first", pointing(hourly, "steps"), 0, { as: "edit", id: "steps", body: fn([literal]), base: 0 });
		unplug();

		const fresh = save("second", pointing(hourly, "steps"), 0);
		const edited = save("first", pointing({ kind: "interval", everyMin: 30 }, "steps"), 1);
		const off = automations.ownerPut(
			"first",
			{ ...pointing({ kind: "interval", everyMin: 30 }, "steps"), enabled: false },
			2,
		);

		expect([refusalOf(fresh), edited.stored, off.stored]).toEqual([
			{ code: "invalid", record: "function", id: "steps" },
			true,
			true,
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

	it("toggles automations with gone or unread functions and refuses relabels", () => {
		const row = (id: string, kind: string, body: object) => ({ id, kind, revision: 1, incarnation: id, body });
		const goneBody = pointing(hourly, "missing");
		const gone = open(true, [row("gone", "automation", goneBody)]);
		const goneOff = gone.automations.ownerPut("gone", { ...goneBody, enabled: false }, 1);
		const goneOn = gone.automations.ownerPut("gone", goneBody, 2);
		const goneRelabel = gone.automations.ownerPut("gone", { ...goneBody, label: "Changed" }, 3);
		const unreadBody = pointing(hourly, "later");
		const unread = open(true, [
			row("later", "function", { name: "Later", params: [], steps: [{ kind: "wait", minutes: 5 }] }),
			row("unread", "automation", unreadBody),
		]);
		const unreadOff = unread.automations.ownerPut("unread", { ...unreadBody, enabled: false }, 1);
		const unreadOn = unread.automations.ownerPut("unread", unreadBody, 2);
		const unreadRelabel = unread.automations.ownerPut("unread", { ...unreadBody, label: "Changed" }, 3);

		expect([goneOff.stored, goneOn.stored, goneRelabel.stored]).toEqual([true, true, false]);
		expect([unreadOff.stored, unreadOn.stored, unreadRelabel.stored]).toEqual([true, true, false]);
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

	it("names the event's words a dangerous step would send out, in its confirm", () => {
		const { automations, save } = open();
		const sending = (value1: StepArg) =>
			refusalOf(
				save(
					"gh",
					pointing(event, "steps", {}),
					0,
					{ as: "edit", id: "steps", body: fn([{ ...bell, args: { ...bell.args, value1 } }]), base: 0 },
					false,
				),
			);
		const flat = automations.ownerPut(
			"flat",
			{
				enabled: true,
				trigger: event,
				actions: [{ kind: "ifttt_trigger", event: "bell", value1: "{event.title} for {event.reason}" }],
			},
			0,
		);

		expect([
			sending(lit("{event}")),
			sending({ kind: "expression", text: "event.reason" }),
			sending(lit("plain")),
			flat.confirm,
		]).toEqual([
			{ code: "confirm", labels: ["Send to IFTTT, with the event's title"] },
			{ code: "confirm", labels: ["Send to IFTTT, with the event's reason"] },
			{ code: "confirm", labels: ["Send to IFTTT"] },
			["Send to IFTTT, with the event's title and reason"],
		]);
	});

	describe("outside reach confirmation", () => {
		it("asks when a missing event function is restored with outside reach", () => {
			const row = (id: string, kind: string, body: object) => ({ id, kind, revision: 1, incarnation: id, body });
			const { save } = open(true, [row("lost", "automation", pointing(event, "steps", { room: PLUG }))]);
			const body = pointing(event, "steps", { room: PLUG });
			const function_ = { as: "edit" as const, id: "steps", body: fn([on], room), base: 0 };

			const prompted = save("lost", body, 1, function_, false);
			const confirmed = save("lost", body, 1, function_);

			expect([refusalOf(prompted), confirmed.stored]).toEqual([
				{ code: "confirm", labels: ["Switch a plug"] },
				true,
			]);
		});

		it("asks when a non-event automation becomes event-triggered with outside reach", () => {
			const { save } = open();
			save("clock", pointing(hourly, "steps", { room: PLUG }), 0, {
				as: "edit",
				id: "steps",
				body: fn([on], room),
				base: 0,
			});

			const promoted = save("clock", pointing(event, "steps", { room: PLUG }), 1, undefined, false);

			expect(refusalOf(promoted)).toMatchObject({ code: "confirm", labels: ["Switch a plug"] });
		});

		it("lets an event automation toggle without asking again", () => {
			const { automations, save } = open();
			const body: AutomationInput = {
				enabled: true,
				trigger: event,
				actions: [{ kind: "tell_assistant", when: "now" }],
			};
			save("told", body, 0);

			const off = automations.ownerPut("told", { ...body, enabled: false }, 1);
			const onAgain = automations.ownerPut("told", body, 2);

			expect([off.stored, onAgain.stored]).toEqual([true, true]);
		});

		it("does not ask again when an event automation keeps its outside reach", () => {
			const { save } = open();
			save("event", pointing(event, "steps", { room: PLUG }), 0, {
				as: "edit",
				id: "steps",
				body: fn([on], room),
				base: 0,
			});

			const relabelled = save(
				"event",
				{ ...pointing(event, "steps", { room: PLUG }), label: "Changed" },
				1,
				undefined,
				false,
			);

			expect(relabelled.stored).toBe(true);
		});
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
				{
					code: "hole",
					record: "function",
					path: "0",
					step: "0",
					param: "device",
					start: 0,
					end: 6,
				},
				{ code: "invalid", record: "function", path: "steps.0.colour", step: "0", param: "colour" },
				{ code: "invalid", record: "function", path: "steps.0.verb", step: "0", param: "verb" },
				{ code: "invalid", record: "function", path: "steps.0.device", step: "0", param: "device" },
				{ code: "invalid", record: "automation", path: "values.room" },
			]);
		});

		it("refuses a step result name on save and leaves a stored one unarmed", () => {
			const assigned = { ...on, as: "result" };
			const { automations, save } = open();
			const refused = save("warm", pointing(hourly, "warm-up", { room: PLUG }), 0, {
				as: "edit",
				id: "warm-up",
				body: fn([assigned], room),
				base: 0,
			});
			const row = (id: string, kind: string, body: object) => ({ id, kind, revision: 1, incarnation: id, body });
			const stored = open(true, [
				row("later", "function", fn([assigned], room)),
				row("event", "automation", pointing(event, "later", { room: PLUG })),
			]);

			expect([refusalOf(refused), automations.list()]).toEqual([
				{
					code: "invalid",
					record: "function",
					path: "steps.0.as",
					step: "0",
					param: "as",
				},
				[],
			]);
			expect(stored.automations.invalidOf("event")).not.toBeNull();
			expect(stored.automations.eventsOf("github")).toEqual([]);
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

		it("refuses a save naming a gone switch with the line its row shows, flat and through a function", () => {
			const { save, automations, unplug } = open();
			const flat: AutomationInput = {
				enabled: true,
				trigger: hourly,
				actions: [{ kind: "device_set", device: PLUG, verb: "on" }],
			};
			save("flat", flat, 0);
			save("warm", pointing(hourly, "warm-up", { room: PLUG }), 0, {
				as: "edit",
				id: "warm-up",
				body: fn([on], room),
				base: 0,
			});
			unplug();
			const refused = [
				save("flat", { ...flat, label: "Lamp on" }, 1),
				save("warm", { ...pointing(hourly, "warm-up", { room: PLUG }), label: "Warm" }, 1),
			].map(refusalOf);

			expect(refused).toEqual([
				{ code: "invalid", record: "automation" },
				{ code: "invalid", record: "automation", path: "values.room" },
			]);
			expect(automations.invalidOf("flat")).toBe(NO_SWITCH);
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
