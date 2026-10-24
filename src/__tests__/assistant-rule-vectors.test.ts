import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	AssistantFieldSpecSchema,
	AssistantRuleSchema,
	parseRuleForFields,
	trimRuleValue,
} from "../shared/schemasAssistantRules.js";

type Vector = {
	name: string;
	field: string;
	test: string;
	value?: string;
	codes?: number[];
	times?: number;
	around?: string;
	fits: boolean;
	canonical?: string;
};

const corpus = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/assistant-rules/vectors.json"), "utf8"),
) as { specs: unknown; cases: Vector[] };

const specs = z.array(AssistantFieldSpecSchema).parse(corpus.specs);

const typed = (vector: Vector) => {
	const base = (vector.codes ? String.fromCodePoint(...vector.codes) : (vector.value ?? "")).repeat(
		vector.times ?? 1,
	);
	return `${vector.around ?? ""}${base}${vector.around ?? ""}`;
};

describe("rule fit, against the shared corpus", () => {
	for (const vector of corpus.cases) {
		it(vector.name, () => {
			const rule = AssistantRuleSchema.safeParse({
				id: "r",
				// The phone sends it trimmed.
				conditions: [{ field: vector.field, test: vector.test, value: trimRuleValue(typed(vector)) }],
				action: "inbox",
				revision: 0,
			});
			const parsed = rule.success ? parseRuleForFields(rule.data, specs) : null;
			expect(parsed?.ok ?? false).toBe(vector.fits);
			if (parsed?.ok && vector.canonical !== undefined) {
				expect(parsed.rule.conditions[0]?.value).toBe(vector.canonical);
			}
		});
	}
});
