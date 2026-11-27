// A source's fields, and the conditions tested against them.

import { z } from "zod";
import { FIELD_TYPES, RULE_TESTS, type RuleTest, UNIT_CODES } from "./field-types.js";
import { ASSISTANT_RULE_VALUE_MAX, CONDITION_VALUES_MAX } from "./wire-vocabulary.js";

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

const conditionValue = z.string().max(ASSISTANT_RULE_VALUE_MAX);

export const AssistantRuleConditionSchema = z
	.object({
		field: z.string().min(1).max(64),
		test: z.enum(RULE_TESTS),
		/** One value, or several. Blank saves, and never fires. */
		value: z.union([conditionValue, z.array(conditionValue).max(CONDITION_VALUES_MAX)]),
	})
	.meta({ id: "AssistantRuleCondition" });

export type AssistantRuleCondition = z.infer<typeof AssistantRuleConditionSchema>;
export type ConditionValue = AssistantRuleCondition["value"];

/** One or many; blank is none. */
export const valuesOf = ({ value }: Pick<AssistantRuleCondition, "value">): string[] =>
	(typeof value === "string" ? [value] : value).filter((held) => trimRuleValue(held) !== "");

/** The text matcher's comparison. */
const sameValue = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Trimmed, each once, one as a string. */
function canonicalValue(values: readonly string[]): ConditionValue {
	const kept: string[] = [];
	for (const value of values.map(trimRuleValue)) {
		if (!kept.some((held) => sameValue(held, value))) kept.push(value);
	}
	if (kept.length === 0) return "";
	return kept.length === 1 ? (kept[0] as string) : kept;
}

const specOf = (specs: readonly AssistantFieldSpec[], field: string) => specs.find((spec) => spec.field === field);

function conditionIssue(condition: AssistantRuleCondition, specs: readonly AssistantFieldSpec[]): string | null {
	const spec = specOf(specs, condition.field);
	if (!spec) return `the rule uses unknown field "${condition.field}"`;
	if (valuesOf(condition).length === 0) return `the rule has no value for ${spec.label}`;
	if (!testsOf(spec).includes(condition.test)) return `${spec.label} takes no "${condition.test}" test`;
	return null;
}

/** As a condition is stored and read. */
export const canonicalConditions = (conditions: readonly AssistantRuleCondition[]): AssistantRuleCondition[] =>
	conditions.map((condition) => ({ ...condition, value: canonicalValue(valuesOf(condition)) }));

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

/** A choice its field no longer holds; it matches nothing. */
export function conditionsWarning(
	conditions: readonly AssistantRuleCondition[],
	specs: readonly AssistantFieldSpec[],
): string | null {
	for (const condition of conditions) {
		const spec = specOf(specs, condition.field);
		if (spec?.kind !== "enumeration") continue;
		const gone = valuesOf(condition).find((value) => !spec.options.some((option) => option.value === value));
		if (gone !== undefined) return `"${gone}" is no longer a ${spec.label} choice`;
	}
	return null;
}

/** Any of, else none of. */
const ANY_OF = { is: true, is_not: false, contains: true, contains_not: false } as const satisfies Record<
	RuleTest,
	boolean
>;
const WITHIN = { is: false, is_not: false, contains: true, contains_not: true } as const satisfies Record<
	RuleTest,
	boolean
>;

/** Missing fields fail every test. */
function holds(condition: AssistantRuleCondition, spec: AssistantFieldSpec, fields: Readonly<Record<string, string>>) {
	if (!Object.hasOwn(fields, condition.field)) return false;
	const actual = fields[condition.field] ?? "";
	const values = valuesOf(condition);
	// A choice no longer offered matches nothing.
	const hit =
		spec.kind === "enumeration"
			? values.some((wanted) => wanted === actual && spec.options.some((option) => option.value === wanted))
			: values.some((wanted) =>
					WITHIN[condition.test]
						? actual.toLowerCase().includes(wanted.toLowerCase())
						: sameValue(actual, wanted),
				);
	return ANY_OF[condition.test] ? hit : !hit;
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
