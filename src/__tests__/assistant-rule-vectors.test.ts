import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	AssistantFieldSpecSchema,
	canonicalConditions,
	conditionsIssue,
	conditionsMatch,
	conditionsWarning,
	trimRuleValue,
} from "../shared/schemasAssistantRules.js";
import { AutomationTriggerSchema } from "../shared/schemasAutomation.js";
import { CONDITION_VALUES_MAX } from "../shared/wire-vocabulary.js";

type Typed = {
	value?: string;
	values?: string[];
	/** Past `CONDITION_VALUES_MAX`. */
	valuesPastMax?: number;
	codes?: number[];
	times?: number;
	around?: string;
};

type Vector = Typed & {
	name: string;
	field: string;
	test: string;
	fits: boolean;
	parses?: boolean;
	warning?: boolean;
	canonical?: string | string[];
};

type Match = Typed & { name: string; field: string; test: string; fields: Record<string, string>; holds: boolean };

const corpus = JSON.parse(
	fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/assistant-rules/vectors.json"), "utf8"),
) as { specs: unknown; cases: Vector[]; matches: Match[] };

const specs = z.array(AssistantFieldSpecSchema).parse(corpus.specs);

// The phone sends each value trimmed.
const typed = (vector: Typed): string | string[] => {
	if (vector.values) return vector.values.map(trimRuleValue);
	if (vector.valuesPastMax !== undefined)
		return Array.from({ length: CONDITION_VALUES_MAX + vector.valuesPastMax }, (_, at) => `v${at}`);
	const base = (vector.codes ? String.fromCodePoint(...vector.codes) : (vector.value ?? "")).repeat(
		vector.times ?? 1,
	);
	return trimRuleValue(`${vector.around ?? ""}${base}${vector.around ?? ""}`);
};

const triggerOf = (vector: Typed & { field: string; test: string }) =>
	AutomationTriggerSchema.safeParse({
		kind: "event",
		source: "github",
		conditions: [{ field: vector.field, test: vector.test, value: typed(vector) }],
	});

describe("condition fit, against the shared corpus", () => {
	for (const vector of corpus.cases) {
		it(vector.name, () => {
			const trigger = triggerOf(vector);
			expect(trigger.success).toBe(vector.parses ?? true);
			const conditions =
				trigger.success && trigger.data.kind === "event" ? canonicalConditions(trigger.data.conditions) : null;
			const fits = conditions !== null && conditionsIssue(conditions, specs) === null;
			expect(fits).toBe(vector.fits);
			expect(conditions !== null && conditionsWarning(conditions, specs) !== null).toBe(vector.warning ?? false);
			if (fits && vector.canonical !== undefined) expect(conditions?.[0]?.value).toEqual(vector.canonical);
		});
	}
});

describe("condition matching, against the shared corpus", () => {
	for (const match of corpus.matches) {
		it(match.name, () => {
			const trigger = triggerOf(match);
			const conditions = trigger.success && trigger.data.kind === "event" ? trigger.data.conditions : null;
			expect(conditions !== null && conditionsMatch(conditions, specs, match.fields)).toBe(match.holds);
		});
	}
});
