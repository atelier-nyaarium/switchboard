import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { byPath, reached, siteAmong, steering, visit, type WalkEntry } from "../shared/automation-walk.js";
import { AutomationSchema } from "../shared/schemasAutomation.js";
import { FunctionSchema } from "../shared/schemasFunction.js";

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

describe("the walk's step path", () => {
	it("reads a step's call site from its path, and orders paths as written", () => {
		const followed = cases.find((vector) => vector.reached.some((row) => row.reach === "step")) as Case;
		const paths = walkOf(followed).map((at) => at.path);

		expect(paths.map((path) => siteAmong(path, ["0"]))).toEqual(["0", "0"]);
		expect(siteAmong("3", ["0"])).toBeNull();
		expect(["10", "2.1", "2", "2.0", "1"].sort(byPath)).toEqual(["1", "2", "2.0", "2.1", "10"]);
	});
});
