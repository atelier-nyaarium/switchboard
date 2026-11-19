import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reached } from "../shared/automation-walk.js";
import { AutomationSchema } from "../shared/schemasAutomation.js";
import { FunctionSchema } from "../shared/schemasFunction.js";

const VECTORS = path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "automation-walk", "vectors.json");

interface Case {
	name: string;
	automation: unknown;
	/** By id; absent walks the automation alone. */
	functions?: Record<string, unknown>;
	reached: { path: string; kind: string }[];
}

const { cases } = JSON.parse(fs.readFileSync(VECTORS, "utf8")) as { cases: Case[] };

describe("the one walk's vectors", () => {
	it.each(cases)("$name", (vector) => {
		const automation = AutomationSchema.parse(vector.automation);
		const functions = new Map(
			Object.entries(vector.functions ?? {}).map(([id, body]) => [id, FunctionSchema.parse(body)]),
		);
		const walk = vector.functions ? reached(automation, (id) => functions.get(id) ?? null) : reached(automation);

		expect(walk.map(({ path, kind }) => ({ path, kind }))).toEqual(vector.reached);
	});
});
