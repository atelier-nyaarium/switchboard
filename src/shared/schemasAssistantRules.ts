// A source's fields, and the conditions tested against them.

import { z } from "zod";
import { FIELD_TYPES, OPERATOR_LABELS, RULE_OPERATORS, type RuleOperator, UNIT_CODES } from "./field-types.js";
import { ASSISTANT_RULE_VALUE_MAX, CONDITION_VALUES_MAX } from "./wire-vocabulary.js";

export { RULE_OPERATORS, type RuleOperator };
export const RULE_ACTIONS = ["wake", "inbox"] as const;
/** The phone mints it; the Gateway keeps it. */
export const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type RuleAction = (typeof RULE_ACTIONS)[number];

/** ASCII whitespace edges only. */
export const trimRuleValue = (value: string): string => value.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");

/** Trimmed, then lower case. */
export const caseKey = (value: string): string => trimRuleValue(value).toLowerCase();

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
			options: z
				.array(AssistantFieldOptionSchema)
				.min(1)
				.max(64)
				// Switch cases ignore case.
				.refine(
					(options) => new Set(options.map((option) => caseKey(option.value))).size === options.length,
					"two options differ only by case",
				),
		}),
		/** Case-insensitive open text. */
		z.strictObject({ kind: z.literal("text"), field: fieldName, label: fieldLabel }),
		/** Thresholds, not condition operators. */
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

export const operatorsOf = (spec: AssistantFieldSpec): readonly RuleOperator[] => FIELD_TYPES[spec.kind].operators;

const conditionValue = z.string().max(ASSISTANT_RULE_VALUE_MAX);

export const AssistantRuleConditionSchema = z
	.object({
		field: z.string().min(1).max(64),
		operator: z.enum(RULE_OPERATORS),
		/** Blank values save inactive. */
		value: z.union([conditionValue, z.array(conditionValue).max(CONDITION_VALUES_MAX)]),
	})
	.meta({ id: "AssistantRuleCondition" });

export type AssistantRuleCondition = z.infer<typeof AssistantRuleConditionSchema>;
export type ConditionValue = AssistantRuleCondition["value"];

/** Blank values mean none. */
export const valuesOf = ({ value }: Pick<AssistantRuleCondition, "value">): string[] =>
	(typeof value === "string" ? [value] : value).filter((held) => trimRuleValue(held) !== "");

/** Case-insensitive text. */
const sameValue = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Trimmed, unique, singleton string. */
function canonicalValue(values: readonly string[]): ConditionValue {
	const kept = [...new Set(values.map(trimRuleValue))];
	if (kept.length === 0) return "";
	return kept.length === 1 ? (kept[0] as string) : kept;
}

const specOf = (specs: readonly AssistantFieldSpec[], field: string) => specs.find((spec) => spec.field === field);

function conditionIssue(condition: AssistantRuleCondition, specs: readonly AssistantFieldSpec[]): string | null {
	const spec = specOf(specs, condition.field);
	if (!spec) return `the automation uses unknown field "${condition.field}"`;
	if (valuesOf(condition).length === 0) return `the automation has no value for ${spec.label}`;
	if (!operatorsOf(spec).includes(condition.operator))
		return `${spec.label} takes no "${OPERATOR_LABELS[condition.operator]}" operator`;
	return null;
}

/** Condition wire format. */
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

/** Reports unavailable choices. */
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

/** Any or none. */
const ANY_OF = { is: true, is_not: false, contains: true, contains_not: false } as const satisfies Record<
	RuleOperator,
	boolean
>;
const WITHIN = { is: false, is_not: false, contains: true, contains_not: true } as const satisfies Record<
	RuleOperator,
	boolean
>;

/** Missing fields never match. */
function holds(condition: AssistantRuleCondition, spec: AssistantFieldSpec, fields: Readonly<Record<string, string>>) {
	if (!Object.hasOwn(fields, condition.field)) return false;
	const actual = fields[condition.field] ?? "";
	const values = valuesOf(condition);
	// Unavailable choices never match.
	const hit =
		spec.kind === "enumeration"
			? values.some((wanted) => wanted === actual && spec.options.some((option) => option.value === wanted))
			: values.some((wanted) =>
					WITHIN[condition.operator]
						? actual.toLowerCase().includes(wanted.toLowerCase())
						: sameValue(actual, wanted),
				);
	return ANY_OF[condition.operator] ? hit : !hit;
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
