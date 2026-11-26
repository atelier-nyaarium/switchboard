import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import pathVectors from "../../tests/fixtures/step-path/vectors.json" with { type: "json" };
import {
	byPath,
	reached,
	type Sealed,
	siteAmong,
	steering,
	stepsOf,
	visit,
	type WalkEntry,
} from "../shared/automation-walk.js";
import { AutomationSchema } from "../shared/schemasAutomation.js";
import { FunctionSchema, type FunctionStep } from "../shared/schemasFunction.js";

const VECTORS = path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "automation-walk", "vectors.json");

interface Case {
	name: string;
	automation: unknown;
	/** By id; absent walks the automation alone. */
	functions?: Record<string, unknown>;
	reached: Row[];
}

interface Row {
	reach: string;
	path: string;
	kind: string;
	index?: number;
	reason?: string;
}

const { cases } = JSON.parse(fs.readFileSync(VECTORS, "utf8")) as { cases: Case[] };

const rowOf = (at: WalkEntry): Row =>
	visit<WalkEntry, Row>(at, {
		action: ({ reach, path, index, action }) => ({ reach, path, index, kind: action.kind }),
		step: {
			do: ({ reach, path, index, step }) => ({ reach, path, index, kind: step.action }),
			call: ({ reach, path, index, step }) => ({ reach, path, index, kind: step.kind }),
			...steering(({ reach, path, index, step }) => ({ reach, path, index, kind: step.kind })),
		},
		unfollowedCall: ({ reach, path, call, reason }) => ({ reach, path, kind: call.kind, reason }),
	});

const walkOf = (vector: Pick<Case, "automation" | "functions">) => {
	const automation = AutomationSchema.parse(vector.automation);
	const functions = new Map(
		Object.entries(vector.functions ?? {}).map(([id, body]) => [id, FunctionSchema.parse(body)]),
	);
	return vector.functions ? reached(automation, (id) => functions.get(id) ?? null) : reached(automation);
};

describe("the one walk's vectors", () => {
	it.each(cases)("$name", (vector) => {
		expect(walkOf(vector).map(rowOf)).toEqual(vector.reached);
	});
});

describe("the walk through a call", () => {
	const tell = { kind: "do", action: "tell_assistant", args: { when: { kind: "literal", value: "now" } } };
	const call = (fn: string) => ({ kind: "call", function: fn });
	const fn = (steps: unknown[]) => ({ name: "F", params: [], steps });
	const pointing = { enabled: true, trigger: { kind: "interval", everyMin: 5 }, actions: [call("a")] };
	const automation = {
		...pointing,
		actions: [{ kind: "run_function", function: "a" }],
	};
	const rows = (functions: Record<string, unknown>) =>
		walkOf({ automation, functions }).map((at) => {
			const row = rowOf(at);
			return [row.path, row.kind, row.reason].filter((part) => part !== undefined);
		});

	it("answers a callee's steps under its call's path, a function reached twice at two paths", () => {
		const reachedTwice = rows({ a: fn([call("b"), tell, call("b")]), b: fn([tell]) });

		expect(reachedTwice).toEqual([
			["0.0", "call"],
			["0.0.0", "tell_assistant"],
			["0.1", "tell_assistant"],
			["0.2", "call"],
			["0.2.0", "tell_assistant"],
		]);
	});

	it("follows no call into a function already above it, one not held, or past its bound", () => {
		const wide = (callee: string) =>
			Array.from({ length: 8 }, () => ({ kind: "if", when: "true", steps: [call(callee), tell, tell] }));
		const looping = rows({ a: fn([call("b")]), b: fn([call("a")]) });
		const missing = rows({ a: fn([call("gone")]) });
		const bounded = rows({ a: fn(wide("b")), b: fn(wide("c")), c: fn([tell]) }).filter(
			(row) => row[2] !== undefined,
		);

		expect(looping.at(-1)).toEqual(["0.0.0", "run_function", "loop"]);
		expect(missing.at(-1)).toEqual(["0.0", "run_function", "missing"]);
		expect(bounded.map((row) => row[2])).toEqual(Array.from({ length: bounded.length }, () => "budget"));
		expect(bounded.length).toBeGreaterThan(0);
	});
});

describe("the step path vectors", () => {
	it.each(pathVectors.cases)("$name", ({ steps, paths }) => {
		// Read raw: a later kind stays a leaf.
		const held = { steps: steps as unknown as Sealed<FunctionStep> };

		expect(stepsOf(held).map((at) => at.path)).toEqual(paths);
	});

	it.each(pathVectors.order)("orders $given as written", ({ given, sorted }) => {
		expect([...given].sort(byPath)).toEqual(sorted);
	});
});

describe("the walk's step path", () => {
	it("reads a step's call site from its path, and orders paths as written", () => {
		const followed = cases.find((vector) => vector.reached.some((row) => row.reach === "step")) as Case;
		const paths = walkOf(followed).map((at) => at.path);

		expect(paths.map((path) => siteAmong(path, ["0"]))).toEqual(["0", "0"]);
		expect(siteAmong("3", ["0"])).toBeNull();
		expect(["10", "2.1", "2", "2.0", "1"].sort(byPath)).toEqual(["1", "2", "2.0", "2.1", "10"]);
	});
});
