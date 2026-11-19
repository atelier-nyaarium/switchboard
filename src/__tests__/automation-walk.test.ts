import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reached } from "../shared/automation-walk.js";
import { AutomationSchema } from "../shared/schemasAutomation.js";

const VECTORS = path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "automation-walk", "vectors.json");

interface Case {
	name: string;
	automation: unknown;
	reached: { path: string; kind: string }[];
}

const { cases } = JSON.parse(fs.readFileSync(VECTORS, "utf8")) as { cases: Case[] };

describe("the one walk's vectors", () => {
	it.each(cases)("$name", (vector) => {
		const automation = AutomationSchema.parse(vector.automation);

		expect(reached(automation).map(({ path, action }) => ({ path, kind: action.kind }))).toEqual(vector.reached);
	});
});
