// A source's fields, and the conditions tested against them.

import { z } from "zod";
import { FIELD_TYPES, RULE_TESTS, type RuleTest, UNIT_CODES } from "./field-types.js";
import { ASSISTANT_RULE_VALUE_MAX } from "./wire-vocabulary.js";

export { RULE_TESTS, type RuleTest };
export const RULE_ACTIONS = ["wake", "inbox"] as const;
/** The phone mints it; the Gateway keeps it. */
export const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type RuleAction = (typeof RULE_ACTIONS)[number];

/** ASCII whitespace edges only. */
export const trimRuleValue = (value: string): string => value.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");

const fieldName = z.string().min(1).max(64);
const fieldLabel = z.string().min(1).max(80);

export const AssistantFieldOptionSchema = z
	.strictObject({
		// A padded option could never be picked.
		value: z
			.string()
			.min(1)
			.max(ASSISTANT_RULE_VALUE_MAX)
			.refine((value) => value === trimRuleValue(value), "an option has no edge whitespace"),
		label: fieldLabel,
	})
	.meta({ id: "AssistantFieldOption" });

/** Source-declared testable fields. */
export const AssistantFieldSpecSchema = z
	.discriminatedUnion("kind", [
		/** Exact values; labels display-only. */
		z.strictObject({
			kind: z.literal("enumeration"),
			field: fieldName,
			label: fieldLabel,
			options: z.array(AssistantFieldOptionSchema).min(1).max(64),
		}),
		/** Case-insensitive open text. */
		z.strictObject({ kind: z.literal("text"), field: fieldName, label: fieldLabel }),
		/** Thresholds, not rule tests. */
		z.strictObject({
			kind: z.literal("number"),
			field: fieldName,
			label: fieldLabel,
			unit: z
				.string()
				.refine((unit) => UNIT_CODES.includes(unit), "unknown unit")
				.optional(),
			decimals: z.number().int().min(0).max(6).optional(),
			min: z.number().optional(),
			max: z.number().optional(),
		}),
		/** Bytes display as hex. */
		z.strictObject({
			kind: z.literal("bytes"),
			field: fieldName,
			label: fieldLabel,
			maxLength: z.number().int().min(1).max(64).optional(),
		}),
	])
	.meta({ id: "AssistantFieldSpec" });

export type AssistantFieldSpec = z.infer<typeof AssistantFieldSpecSchema>;

export const testsOf = (spec: AssistantFieldSpec): readonly RuleTest[] => FIELD_TYPES[spec.kind].tests;

export const AssistantRuleConditionSchema = z
	.object({
		field: z.string().min(1).max(64),
		test: z.enum(RULE_TESTS),
		value: z.string().min(1).max(ASSISTANT_RULE_VALUE_MAX),
	})
	.meta({ id: "AssistantRuleCondition" });

export type AssistantRuleCondition = z.infer<typeof AssistantRuleConditionSchema>;

const specOf = (specs: readonly AssistantFieldSpec[], field: string) => specs.find((spec) => spec.field === field);

function conditionIssue(condition: AssistantRuleCondition, specs: readonly AssistantFieldSpec[]): string | null {
	const spec = specOf(specs, condition.field);
	if (!spec) return `the rule uses unknown field "${condition.field}"`;
	if (trimRuleValue(condition.value) === "") return `the rule has no value for ${spec.label}`;
	if (!testsOf(spec).includes(condition.test)) return `${spec.label} takes no "${condition.test}" test`;
	if (spec.kind === "enumeration" && !spec.options.some((option) => option.value === condition.value)) {
		return `"${condition.value}" is not a ${spec.label} choice`;
	}
	return null;
}

/** Trimmed, as a condition is stored and read. */
export const canonicalConditions = (conditions: readonly AssistantRuleCondition[]): AssistantRuleCondition[] =>
	conditions.map((condition) => ({ ...condition, value: trimRuleValue(condition.value) }));

/** Why canonical conditions do not fit a source's fields. */
export function conditionsIssue(
	conditions: readonly AssistantRuleCondition[],
	specs: readonly AssistantFieldSpec[],
): string | null {
	for (const condition of conditions) {
		const issue = conditionIssue(condition, specs);
		if (issue) return issue;
	}
	return null;
}

/** Missing fields fail even `is_not`. */
function holds(condition: AssistantRuleCondition, spec: AssistantFieldSpec, fields: Readonly<Record<string, string>>) {
	if (!Object.hasOwn(fields, condition.field)) return false;
	const actual = fields[condition.field] ?? "";
	if (spec.kind === "enumeration")
		return condition.test === "is" ? actual === condition.value : actual !== condition.value;
	const seen = actual.toLowerCase();
	const wanted = condition.value.toLowerCase();
	if (condition.test === "is") return seen === wanted;
	if (condition.test === "is_not") return seen !== wanted;
	return seen.includes(wanted);
}

/** Every condition holds; conditions that do not fit never match. */
export function conditionsMatch(
	conditions: readonly AssistantRuleCondition[],
	specs: readonly AssistantFieldSpec[],
	fields: Readonly<Record<string, string>>,
): boolean {
	// The canonical form, so what parses is what matches.
	const canonical = canonicalConditions(conditions);
	if (conditionsIssue(canonical, specs) !== null) return false;
	return canonical.every((condition) => {
		const spec = specOf(specs, condition.field);
		return spec !== undefined && holds(condition, spec, fields);
	});
}
