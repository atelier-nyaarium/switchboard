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
		taken?: { shown: string; case: number }[];
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
			const taken = vector.taken ?? [];
			expect(taken.map(({ shown }) => caseTaken(vector.cases, shown, vector.choices))).toEqual(
				taken.map((held) => held.case),
			);
		});
	}
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
