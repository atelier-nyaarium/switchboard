import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import vectors from "../../tests/fixtures/automation-carry/vectors.json" with { type: "json" };
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import { FUNCTION_UNUSED_KEEP_MS } from "../gateway/computed/automations.js";
import { FUNCTION_LEFT, FUNCTION_UNFIT } from "../gateway/computed/automationValidity.js";
import { evaluateHole, fillHoles, holeIssue } from "../gateway/liveConsole/holes.js";
import { createConsoleRegistry } from "../gateway/liveConsole/registry.js";
import { carriedFunctionsOf } from "../shared/automation-carry.js";
import { reached } from "../shared/automation-walk.js";
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

function destination(held: readonly (readonly string[])[], now = { at: 1_000 }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-carry-"));
	roots.push(dir);
	const rows = held.map(([id, shape, name]) => ({
		id,
		kind: shape === "function" ? "function" : "automation",
		revision: 1,
		incarnation: `held-${id}`,
		body:
			shape === "function"
				? fn(name ?? "")
				: shape === "unread"
					? UNREAD
					: (SHAPES[shape ?? ""] ?? runsAt(shape)),
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
			holes: () => ({
				issue: (text, names) => holeIssue(text, names, REGISTRY),
				fill: (text, names) => fillHoles(text, names, REGISTRY),
				evaluate: (source, names) => evaluateHole(source, names, REGISTRY),
			}),
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
					const call = body ? reached(body).find((at) => at.action.kind === "run_function") : undefined;
					return [id, call?.action.kind === "run_function" ? call.action.function : null];
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
		const call = body ? reached(body).find((at) => at.action.kind === "run_function") : undefined;
		return call?.action.kind === "run_function" ? call.action.function : null;
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
