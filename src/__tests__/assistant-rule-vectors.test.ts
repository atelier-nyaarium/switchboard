import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	AssistantFieldSpecSchema,
	canonicalConditions,
	conditionsIssue,
	trimRuleValue,
} from "../shared/schemasAssistantRules.js";
import { AutomationTriggerSchema } from "../shared/schemasAutomation.js";

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

describe("condition fit, against the shared corpus", () => {
	for (const vector of corpus.cases) {
		it(vector.name, () => {
			const trigger = AutomationTriggerSchema.safeParse({
				kind: "event",
				source: "github",
				// The phone sends it trimmed.
				conditions: [{ field: vector.field, test: vector.test, value: trimRuleValue(typed(vector)) }],
			});
			const conditions =
				trigger.success && trigger.data.kind === "event" ? canonicalConditions(trigger.data.conditions) : null;
			const fits = conditions !== null && conditionsIssue(conditions, specs) === null;
			expect(fits).toBe(vector.fits);
			if (fits && vector.canonical !== undefined) expect(conditions?.[0]?.value).toBe(vector.canonical);
		});
	}
});
