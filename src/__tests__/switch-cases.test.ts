import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssistantFieldSpecSchema } from "../shared/schemasAssistantRules.js";
import { caseKey, caseTaken, choiceFieldOf, switchIssues } from "../shared/switch-cases.js";

interface Vectors {
	keys: { value: string; key: string }[];
	choiceFields: { subject: string; field: string | null }[];
	issues: {
		name: string;
		cases: { values: string[] }[];
		choices: string[] | null;
		issues: ReturnType<typeof switchIssues>;
	}[];
}

const vectors = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/switch-cases/vectors.json"), "utf8"),
) as Vectors;

describe("the switch case vectors", () => {
	it("key each value", () => {
		expect(vectors.keys.map(({ value }) => caseKey(value))).toEqual(vectors.keys.map(({ key }) => key));
	});

	it("read a choice subject only as exactly event.<field>", () => {
		expect(vectors.choiceFields.map(({ subject }) => choiceFieldOf(subject))).toEqual(
			vectors.choiceFields.map(({ field }) => field),
		);
	});

	for (const vector of vectors.issues) {
		it(vector.name, () => {
			expect(switchIssues(vector, vector.choices)).toEqual(vector.issues);
		});
	}
});

describe("the case a subject takes", () => {
	const cases = [{ values: ["Mention", "assign"] }, { values: ["review"] }];

	it("is the first holding it ignoring case, else past the last", () => {
		expect([" MENTION ", "review", "other"].map((shown) => caseTaken(cases, shown))).toEqual([0, 1, 2]);
	});
});

describe("a choice field's options", () => {
	it("refuse two that differ only by case", () => {
		const spec = (values: string[]) => ({
			kind: "enumeration",
			field: "reason",
			label: "Reason",
			options: values.map((value) => ({ value, label: value })),
		});
		expect([
			AssistantFieldSpecSchema.safeParse(spec(["open", "closed"])).success,
			AssistantFieldSpecSchema.safeParse(spec(["open", "Open"])).success,
		]).toEqual([true, false]);
	});
});
