import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import vectors from "../../tests/fixtures/automation-carry/vectors.json" with { type: "json" };
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import { FUNCTION_UNUSED_KEEP_MS } from "../gateway/computed/automations.js";
import { FUNCTION_LEFT, FUNCTION_PRIVATE, FUNCTION_UNFIT } from "../gateway/computed/automationValidity.js";
import { holesOver } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { carriedFunctionsOf } from "../shared/automation-carry.js";
import { callsOf, pointerOf } from "../shared/automation-walk.js";
import { unknown } from "../shared/expressions.js";
import { AssistantHomeSealedSchema, readableSealed } from "../shared/schemasAssistantHome.js";
import {
	type AutomationInput,
	AutomationSchema,
	CarriedAutomationSchema,
	CarriedFunctionSchema,
} from "../shared/schemasAutomation.js";
import { FunctionSchema } from "../shared/schemasFunction.js";

const REGISTRY = createConsoleRegistry([]);
/** Fixed ids. */
const KEY = Buffer.alloc(32, 7);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const tell = { kind: "do", action: "tell_assistant", args: { when: { kind: "literal", value: "now" } } } as const;
const fn = (name: string) => ({ name, params: [], steps: [tell] });
const runs: AutomationInput["actions"] = [{ kind: "run_function", function: "warm-up" }];
const event: AutomationInput["trigger"] = { kind: "event", source: "github", conditions: [] };
const hourly: AutomationInput["trigger"] = { kind: "interval", everyMin: 60 };
const SHAPES: Record<string, AutomationInput> = {
	automation: { enabled: true, trigger: hourly, actions: runs },
	event: { enabled: true, trigger: event, actions: runs },
	flat: { enabled: true, trigger: hourly, actions: [{ kind: "tell_assistant", when: "now" }] },
	chimes: { enabled: true, trigger: hourly, actions: [{ kind: "run_function", function: "chime" }] },
};

/** A staying automation running that id. */
const runsAt = (id = ""): AutomationInput => ({
	enabled: true,
	trigger: hourly,
	actions: [{ kind: "run_function", function: id }],
});

/** A trigger kind a later build added. */
const UNREAD = { enabled: true, trigger: { kind: "geofence", place: "home" }, actions: runs };

type IdSpec = string | { copyOf: string };
const carryId = (from: string) =>
	`fn-${createHmac("sha256", KEY).update(`carry\0\0${from}`).digest("hex").slice(0, 16)}`;
const idOf = (spec: IdSpec) => (typeof spec === "string" ? spec : carryId(spec.copyOf));

function destination(
	held: readonly (readonly string[])[],
	now = { at: 1_000 },
	/** A held row's own body, by id. */
	bodies: Record<string, unknown> = {},
) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-carry-"));
	roots.push(dir);
	const rows = held.map(([id, shape, name]) => ({
		id,
		kind: shape === "function" ? "function" : "automation",
		revision: 1,
		incarnation: `held-${id}`,
		body:
			bodies[id ?? ""] ??
			(shape === "function"
				? fn(name ?? "")
				: shape === "unread"
					? UNREAD
					: (SHAPES[shape ?? ""] ?? runsAt(shape))),
	}));
	fs.writeFileSync(path.join(dir, "automations.json"), JSON.stringify(rows));
	fs.writeFileSync(path.join(dir, "automation-function-key.json"), JSON.stringify({ key: KEY.toString("base64") }));
	let n = 0;
	const { automations } = openAutomationPair({
		dataDir: dir,
		newIncarnation: () => `a${++n}`,
		now: () => now.at,
		input: () => ({ type: { type: "number", integral: false }, value: unknown("not heard") }),
		automations: {
			isHome: () => true,
			eventIssue: () => null,
			eventFields: () => [],
			holes: () => holesOver(REGISTRY),
		},
	});
	const functions = () =>
		(
			JSON.parse(fs.readFileSync(path.join(dir, "automations.json"), "utf8")) as {
				id: string;
				kind: string;
				body: { name: string };
			}[]
		)
			.filter((row) => row.kind === "function")
			.map((row) => [row.id, row.body.name])
			.sort();
	const revisionOf = (id: string) =>
		(
			JSON.parse(fs.readFileSync(path.join(dir, "automations.json"), "utf8")) as {
				id: string;
				revision: number;
			}[]
		).find((row) => row.id === id)?.revision;
	return { automations, functions, revisionOf };
}

describe("the carry vectors", () => {
	for (const { name, automations, listed, expect: picked } of vectors.pick) {
		it(`picks: ${name}`, () => {
			const carried = carriedFunctionsOf(
				automations.map((row) => CarriedAutomationSchema.parse(row)),
				listed.map((row) => CarriedFunctionSchema.parse(row)),
			);
			expect(carried.map((row) => row.id)).toEqual(picked);
		});
	}

	for (const { name, held, carried, times = 1, expect: landed } of vectors.land as unknown as {
		name: string;
		held: string[][];
		carried: { automations: string[]; functions: string[][] | null };
		times?: number;
		expect: {
			points: Record<string, IdSpec>;
			functions: [IdSpec, string][];
			invalid: Record<string, string | null>;
		};
	}[]) {
		it(`lands: ${name}`, () => {
			const { automations, functions } = destination(held);
			const intent = {
				kind: "carry" as const,
				rows: carried.automations.map((id) => ({ id, automation: AutomationSchema.parse(SHAPES.event) })),
				functions:
					carried.functions?.map(([id, label]) => ({
						id: id ?? "",
						function: FunctionSchema.parse(fn(label ?? "")),
					})) ?? null,
			};
			const writes = Array.from({ length: times }, () => automations.write(intent).written);
			const points = Object.fromEntries(
				Object.keys(landed.points).map((id) => {
					const body = automations.list().find((record) => record.id === id)?.body;
					return [id, (body && pointerOf(body)?.function) ?? null];
				}),
			);
			const invalid = Object.fromEntries(
				Object.keys(landed.invalid).map((id) => [id, automations.invalidOf(id)]),
			);

			expect(writes.every(Boolean)).toBe(true);
			expect(points).toEqual(
				Object.fromEntries(Object.entries(landed.points).map(([id, spec]) => [id, idOf(spec)])),
			);
			expect(functions()).toEqual(landed.functions.map(([spec, label]) => [idOf(spec), label]).sort());
			expect(invalid).toEqual(
				Object.fromEntries(
					Object.entries(landed.invalid).map(([id, line]) => [id, line === "left" ? FUNCTION_LEFT : null]),
				),
			);
		});
	}
});

describe("a carry claiming a derived id", () => {
	const carry = (
		automations: ReturnType<typeof destination>["automations"],
		rows: [string, string][],
		functions: [string, string][] | null,
	) =>
		automations.write({
			kind: "carry",
			rows: rows.map(([id, runs]) => ({
				id,
				automation: AutomationSchema.parse({
					enabled: true,
					trigger: event,
					actions: [{ kind: "run_function", function: runs }],
				}),
			})),
			functions: functions?.map(([id, label]) => ({ id, function: FunctionSchema.parse(fn(label)) })) ?? null,
		});
	const pointOf = (automations: ReturnType<typeof destination>["automations"], id: string) => {
		const body = automations.list().find((record) => record.id === id)?.body;
		return (body && pointerOf(body)?.function) ?? null;
	};
	const d = carryId("warm-up");

	it("passes over a derived id a staying automation runs, for a landing and for an older phone's repoint", () => {
		const held = [
			["stays", "automation"],
			["warm-up", "function", "Stays"],
			["stays2", `runs:${d}`],
			[d, "function", "Copy"],
		];
		const landed = destination(held);
		const older = destination(held);
		carry(landed.automations, [["a", "warm-up"]], [["warm-up", "Moved"]]);
		carry(older.automations, [["a", "warm-up"]], null);

		expect(pointOf(landed.automations, "a")).toBe(carryId(d));
		expect(landed.functions()).toEqual(
			[
				[carryId(d), "Moved"],
				[d, "Copy"],
				["warm-up", "Stays"],
			].sort(),
		);
		expect([pointOf(older.automations, "a"), older.automations.invalidOf("a")]).toEqual([
			carryId(d),
			FUNCTION_LEFT,
		]);
		expect(older.functions()).toEqual(
			[
				[d, "Copy"],
				["warm-up", "Stays"],
			].sort(),
		);
	});

	it("never lands two carried functions on one id", () => {
		const { automations, functions } = destination([
			["stays", "automation"],
			["warm-up", "function", "Stays"],
		]);
		const moved = carry(
			automations,
			[
				["a", "warm-up"],
				["b", d],
			],
			[
				["warm-up", "Moved"],
				[d, "Other"],
			],
		);

		expect(moved.written).toBe(true);
		expect([pointOf(automations, "a"), pointOf(automations, "b")]).toEqual([d, carryId(d)]);
		expect(functions()).toEqual(
			[
				[d, "Moved"],
				[carryId(d), "Other"],
				["warm-up", "Stays"],
			].sort(),
		);
	});

	it("refuses with its own code when every id on the chain is a function a staying automation runs", () => {
		const chain = ["warm-up"];
		while (chain.length < 8) chain.push(carryId(chain[chain.length - 1] ?? ""));
		const { automations } = destination(
			chain.flatMap((id, at) => [
				[id, "function", `F${at}`],
				[`s${at}`, `runs:${id}`],
			]),
		);
		const moved = carry(automations, [["a", "warm-up"]], [["warm-up", "Moved"]]);

		expect(moved).toMatchObject({ written: false, refusal: { code: "no_free_id" } });
	});

	it("keeps its own function as held in a move in place, from either phone, whatever body the move carries", () => {
		const held = [
			["m", "event"],
			["stays", "automation"],
			["warm-up", "function", "Shared"],
		];
		const newer = destination(held);
		const older = destination(held);
		carry(newer.automations, [["m", "warm-up"]], [["warm-up", "Stale"]]);
		carry(older.automations, [["m", "warm-up"]], null);

		for (const { automations, functions, revisionOf } of [newer, older]) {
			expect([pointOf(automations, "m"), automations.invalidOf("m")]).toEqual(["warm-up", null]);
			expect([functions(), revisionOf("warm-up")]).toEqual([[["warm-up", "Shared"]], 1]);
		}
	});
});

describe("a carry through calls", () => {
	const calling = (name: string, ...callees: string[]) => ({
		name,
		params: [],
		steps: [{ kind: "try", steps: [tell], catch: callees.map((callee) => ({ kind: "call", function: callee })) }],
	});
	const carry = (automations: ReturnType<typeof destination>["automations"], functions: [string, unknown][]) =>
		automations.write({
			kind: "carry",
			rows: [{ id: "a", automation: AutomationSchema.parse(SHAPES.event) }],
			functions: functions.map(([id, body]) => ({ id, function: FunctionSchema.parse(body) })),
		});
	const calls = (automations: ReturnType<typeof destination>["automations"], id: string) => {
		const held = automations.functionOf(id);
		return held ? callsOf(held) : null;
	};
	const c = carryId("chime");

	it("lands a called function beside a stayer's of its id, and the call follows it there", () => {
		const { automations, functions } = destination([
			["clock", "chimes"],
			["chime", "function", "Stays"],
		]);
		const moved = carry(automations, [
			["warm-up", calling("Moved", "chime")],
			["chime", fn("Called")],
		]);

		expect(moved.written).toBe(true);
		expect([calls(automations, "warm-up"), automations.invalidOf("a")]).toEqual([[c], null]);
		expect(functions()).toEqual(
			[
				["chime", "Stays"],
				[c, "Called"],
				["warm-up", "Moved"],
			].sort(),
		);
	});

	it("binds a call whose function did not come to no stayer's, and the automation reads why", () => {
		const { automations, functions } = destination([
			["clock", "chimes"],
			["chime", "function", "Stays"],
		]);
		carry(automations, [["warm-up", calling("Moved", "chime")]]);

		expect(calls(automations, "warm-up")).toEqual([c]);
		expect(automations.invalidOf("a")).toBe(FUNCTION_LEFT);
		expect(functions()).toEqual(
			[
				["chime", "Stays"],
				["warm-up", "Moved"],
			].sort(),
		);
	});

	it("lands a pointer and a call whose function did not come where nothing is held, never on a function a let-go kept", () => {
		const { automations, functions } = destination([
			["chime", "function", "Kept"],
			["bell", "function", "Kept too"],
		]);
		automations.write({
			kind: "carry",
			rows: [
				{ id: "a", automation: AutomationSchema.parse(SHAPES.event) },
				{ id: "b", automation: AutomationSchema.parse({ ...SHAPES.event, actions: SHAPES.chimes?.actions }) },
			],
			functions: [{ id: "warm-up", function: FunctionSchema.parse(calling("Moved", "bell")) }],
		});
		const pointed = automations.list().find((record) => record.id === "b")?.body;

		expect([calls(automations, "warm-up"), pointed && pointerOf(pointed)?.function]).toEqual([
			[carryId("bell")],
			carryId("chime"),
		]);
		expect([automations.invalidOf("a"), automations.invalidOf("b")]).toEqual([FUNCTION_LEFT, FUNCTION_LEFT]);
		expect(functions()).toEqual(
			[
				["bell", "Kept too"],
				["chime", "Kept"],
				["warm-up", "Moved"],
			].sort(),
		);
	});

	it("writes over no function a move in place keeps, lands an arriving function beside it, and binds no arriving call to one that did not come", () => {
		const k = carryId("x");
		const { automations, functions, revisionOf } = destination(
			[
				["a", "event"],
				["x", "flat"],
				["warm-up", "function", "Held"],
				[k, "function", "Held callee"],
				["chime", "function", "Held too"],
			],
			{ at: 1_000 },
			{ "warm-up": calling("Held", k, "chime") },
		);
		const runs = (fn: string) =>
			AutomationSchema.parse({ ...SHAPES.event, actions: [{ kind: "run_function", function: fn }] });
		automations.write({
			kind: "carry",
			rows: [
				{ id: "a", automation: AutomationSchema.parse(SHAPES.event) },
				{ id: "b", automation: runs("x") },
				{ id: "c", automation: runs("bell") },
			],
			functions: [
				{ id: "x", function: FunctionSchema.parse(fn("Moved")) },
				{ id: "warm-up", function: FunctionSchema.parse(calling("Stale", k, "chime")) },
				{ id: "bell", function: FunctionSchema.parse(calling("Bell", "chime")) },
			],
		});

		const arrived = automations.list().find((record) => record.id === "b")?.body;

		expect([revisionOf(k), revisionOf("warm-up"), revisionOf("chime")]).toEqual([1, 1, 1]);
		expect(arrived && pointerOf(arrived)?.function).toBe(carryId(k));
		expect([calls(automations, "bell"), automations.invalidOf("c")]).toEqual([[carryId("chime")], FUNCTION_LEFT]);
		expect(functions()).toEqual(
			[
				[k, "Held callee"],
				[carryId(k), "Moved"],
				["bell", "Bell"],
				["chime", "Held too"],
				["warm-up", "Held"],
			].sort(),
		);
	});

	it.each([
		["on its own id", [] as string[][], "chime"],
		[
			"on a derived id",
			[
				["clock", "chimes"],
				["chime", "function", "Stays"],
			],
			carryId("chime"),
		],
	])(
		"lands the same rows when a move whose pointer and call share a function that did not come, landed %s, is run again",
		(_where, held, landed) => {
			const { automations, functions } = destination(held);
			const runs = (fn: string) =>
				AutomationSchema.parse({ ...SHAPES.event, actions: [{ kind: "run_function", function: fn }] });
			const carry = () =>
				automations.write({
					kind: "carry",
					rows: [
						{ id: "a", automation: runs("chime") },
						{ id: "b", automation: runs("warm-up") },
					],
					functions: [{ id: "warm-up", function: FunctionSchema.parse(calling("Moved", "chime")) }],
				});
			const rows = () => [
				automations.list().map((record) => [record.id, pointerOf(record.body)?.function, record.revision]),
				calls(automations, "warm-up"),
				functions(),
			];
			carry();
			const first = rows();
			carry();

			expect(rows()).toEqual(first);
			expect(first[1]).toEqual([landed]);
		},
	);

	it("lands an arriving function when the id its held automation points at is another automation's unread row", () => {
		const { automations, functions } = destination(
			[
				["a", "event"],
				["warm-up", "unread"],
			],
			{ at: 1_000 },
		);
		automations.write({
			kind: "carry",
			rows: [
				{
					id: "a",
					automation: AutomationSchema.parse({ ...SHAPES.event, actions: SHAPES.chimes?.actions }),
				},
			],
			functions: [{ id: "chime", function: FunctionSchema.parse(fn("Moved")) }],
		});

		expect([automations.invalidOf("a"), functions()]).toEqual([null, [["chime", "Moved"]]]);
	});

	it("never lands a carried function on an id a move in place keeps, whatever order they come in", () => {
		const k = carryId("x");
		const { automations, functions, revisionOf } = destination(
			[
				["a", "event"],
				["x", "flat"],
				["warm-up", "function", "Held"],
				[k, "function", "Held callee"],
			],
			{ at: 1_000 },
			{ "warm-up": calling("Held", k) },
		);
		automations.write({
			kind: "carry",
			rows: [
				{ id: "a", automation: AutomationSchema.parse(SHAPES.event) },
				{
					id: "b",
					automation: AutomationSchema.parse({
						...SHAPES.event,
						actions: [{ kind: "run_function", function: "x" }],
					}),
				},
			],
			functions: [
				{ id: "x", function: FunctionSchema.parse(fn("Moved")) },
				{ id: k, function: FunctionSchema.parse(fn("Stale callee")) },
				{ id: "warm-up", function: FunctionSchema.parse(calling("Stale", k)) },
			],
		});

		expect([revisionOf(k), revisionOf("warm-up")]).toEqual([1, 1]);
		expect(functions()).toEqual(
			[
				[k, "Held callee"],
				[carryId(k), "Moved"],
				["warm-up", "Held"],
			].sort(),
		);
	});

	it("judges a move over functions that call each other many ways without walking every way", () => {
		const ids = Array.from({ length: 32 }, (_, at) => `f${at}`);
		const bodies = Object.fromEntries(
			ids.map((id, at) => [
				id,
				{
					name: id,
					params: [],
					steps:
						at === 31
							? [tell]
							: ids.slice(at + 1, at + 9).map((callee) => ({ kind: "call", function: callee })),
				},
			]),
		);
		const { automations } = destination(
			[["old", "event"], ...ids.map((id) => [id, "function", id])],
			{ at: 1_000 },
			{ ...bodies, old: { ...SHAPES.event, actions: [{ kind: "run_function", function: "f0" }] } },
		);
		const moved = automations.write({
			kind: "carry",
			rows: [
				{
					id: "new",
					automation: AutomationSchema.parse({
						...SHAPES.event,
						actions: [{ kind: "run_function", function: "f31" }],
					}),
				},
			],
			functions: [{ id: "f31", function: FunctionSchema.parse(fn("Moved")) }],
		});

		expect(moved.written).toBe(true);
	});

	it("keeps what its own function calls as held in a move in place, and writes no second copy", () => {
		const { automations, functions, revisionOf } = destination(
			[
				["a", "event"],
				["warm-up", "function", "Held"],
				["chime", "function", "Held callee"],
			],
			{ at: 1_000 },
			{ "warm-up": calling("Held", "chime") },
		);
		carry(automations, [
			["warm-up", calling("Stale", "chime")],
			["chime", fn("Stale callee")],
		]);

		expect([calls(automations, "warm-up"), automations.invalidOf("a")]).toEqual([["chime"], null]);
		expect([functions(), revisionOf("warm-up"), revisionOf("chime")]).toEqual([
			[
				["chime", "Held callee"],
				["warm-up", "Held"],
			],
			1,
			1,
		]);
	});

	it("takes the id of a held function only a moving automation's function calls", () => {
		const { automations, functions } = destination(
			[
				["gone", "event"],
				["warm-up", "function", "Old"],
				["chime", "function", "Old callee"],
			],
			{ at: 1_000 },
			{ "warm-up": calling("Old", "chime") },
		);
		automations.write({
			kind: "carry",
			rows: [
				{ id: "b", automation: AutomationSchema.parse({ ...SHAPES.event, actions: SHAPES.chimes?.actions }) },
			],
			functions: [{ id: "chime", function: FunctionSchema.parse(fn("New")) }],
		});

		expect(functions()).toEqual(
			[
				["chime", "New"],
				["warm-up", "Old"],
			].sort(),
		);
	});
});

describe("a carried function with no name", () => {
	it("reads invalid for every automation when a move lands it shared or called", () => {
		const { automations } = destination([]);
		const points = (fn: string) =>
			AutomationSchema.parse({ ...SHAPES.event, actions: [{ kind: "run_function", function: fn }] });
		const calls = { name: "Caller", params: [], steps: [{ kind: "call", function: "own" }] };
		automations.write({
			kind: "carry",
			rows: [
				{ id: "a", automation: points("own") },
				{ id: "b", automation: points("own") },
				{ id: "c", automation: points("caller") },
				{ id: "d", automation: points("alone") },
			],
			functions: [
				{ id: "own", function: FunctionSchema.parse(fn("")) },
				{ id: "caller", function: FunctionSchema.parse(calls) },
				{ id: "alone", function: FunctionSchema.parse(fn("")) },
			],
		});

		expect(["a", "b", "c", "d"].map((id) => automations.invalidOf(id))).toEqual([
			FUNCTION_PRIVATE,
			FUNCTION_PRIVATE,
			FUNCTION_PRIVATE,
			null,
		]);
	});
});

describe("a function reached only through calls", () => {
	const calling = (name: string, callee: string) => ({
		name,
		params: [],
		steps: [{ kind: "call", function: callee }],
	});

	it("is listed with who calls it and whether a reacher moves, and is swept with what called it once nothing runs either", () => {
		const now = { at: 1_000 };
		const { automations, functions } = destination(
			[
				["moving", "event"],
				["warm-up", "function", "Warm up"],
				["chime", "function", "Chime"],
				["idle", "function", "Idle"],
				["bell", "function", "Bell"],
			],
			now,
			{ "warm-up": calling("Warm up", "chime"), idle: calling("Idle", "bell") },
		);
		const listed = automations.listing().functions.map((row) => [row.id, row.users, row.callers, row.moves]);
		automations.sweepFunctions();
		now.at += FUNCTION_UNUSED_KEEP_MS;
		automations.sweepFunctions();

		expect(listed).toEqual([
			["warm-up", ["moving"], [], true],
			["chime", [], ["warm-up"], true],
		]);
		expect(functions()).toEqual([
			["chime", "Chime"],
			["warm-up", "Warm up"],
		]);
	});
});

describe("a carried function written unfit", () => {
	it("reads invalid on every read, for a refused hole and for a field its source does not give", () => {
		const { automations } = destination([]);
		const lit = (value: string) => ({ kind: "literal" as const, value });
		const telling = (message: string) => ({
			name: "Tell",
			params: [],
			steps: [{ kind: "do", action: "tell_assistant", args: { when: lit("now"), message: lit(message) } }],
		});
		automations.write({
			kind: "carry",
			rows: ["hole", "field"].map((id) => ({
				id,
				automation: AutomationSchema.parse({
					enabled: true,
					trigger: event,
					actions: [{ kind: "run_function", function: `${id}-fn` }],
				}),
			})),
			functions: [
				{ id: "hole-fn", function: FunctionSchema.parse(telling("{nowhere}")) },
				{ id: "field-fn", function: FunctionSchema.parse(telling("{event.repo}")) },
			],
		});

		expect(automations.invalidOf("hole")).toMatch(/nowhere/);
		expect(automations.invalidOf("field")).toBe(FUNCTION_UNFIT);
	});
});

describe("a sealed carry from a newer build", () => {
	it("drops a carried function this build cannot read, never the move", () => {
		const good = { id: "warm-up", function: fn("Warm up") };
		const newer = { id: "later", function: { ...fn("Later"), steps: [{ kind: "wait", minutes: 5 }] } };
		const read = readableSealed({
			workdirPath: "~/notes",
			carried: { approveEverySend: true, watchers: [], functions: [good, newer] },
		});

		expect(read.dropped).toBe(1);
		expect(AssistantHomeSealedSchema.parse(read.sealed).carried?.functions?.map((row) => row.id)).toEqual([
			"warm-up",
		]);
	});
});

describe("a function a let-go left without users", () => {
	it("is kept unlisted for a week, then swept, and one a user still runs is never swept", () => {
		const now = { at: 1_000 };
		const { automations, functions } = destination(
			[
				["moving", "event"],
				["warm-up", "function", "Warm up"],
				["clock", "chimes"],
				["chime", "function", "Chime"],
			],
			now,
		);
		automations.write({ kind: "carry", rows: [], functions: [] });
		automations.sweepFunctions();
		const left = functions();
		const listed = automations.listing().functions.map((row) => row.id);
		now.at += FUNCTION_UNUSED_KEEP_MS - 1;
		automations.sweepFunctions();
		const kept = functions();
		now.at += 1;
		automations.sweepFunctions();

		const both = [
			["chime", "Chime"],
			["warm-up", "Warm up"],
		];
		expect([left, listed, kept]).toEqual([both, ["chime"], both]);
		expect(functions()).toEqual([["chime", "Chime"]]);
	});
});
