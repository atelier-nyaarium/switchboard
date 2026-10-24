// Watcher rules: ordered, first match wins.

import { z } from "zod";
import { ASSISTANT_RULE_CONDITIONS_MAX, ASSISTANT_RULE_VALUE_MAX, ASSISTANT_RULES_MAX } from "./wire-vocabulary.js";

export const RULE_TESTS = ["is", "is_not", "contains"] as const;
/** Enumeration tests. */
export const CHOICE_TESTS = ["is", "is_not"] as const;
export const RULE_ACTIONS = ["wake", "inbox"] as const;
/** The phone mints it; the Gateway keeps it. */
export const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type RuleAction = (typeof RULE_ACTIONS)[number];
export type RuleTest = (typeof RULE_TESTS)[number];

const fieldName = z.string().min(1).max(64);
const fieldLabel = z.string().min(1).max(80);

export const AssistantFieldOptionSchema = z
	.strictObject({ value: z.string().min(1).max(ASSISTANT_RULE_VALUE_MAX), label: fieldLabel })
	.meta({ id: "AssistantFieldOption" });

/** Watcher-declared testable fields. */
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
	])
	.meta({ id: "AssistantFieldSpec" });

export type AssistantFieldSpec = z.infer<typeof AssistantFieldSpecSchema>;

export const testsOf = (spec: AssistantFieldSpec): readonly RuleTest[] =>
	spec.kind === "enumeration" ? CHOICE_TESTS : RULE_TESTS;

export const fieldsOf = (specs: readonly AssistantFieldSpec[]): string[] => specs.map((spec) => spec.field);

/** Out-of-set field value. */
export const AssistantFieldValueSchema = z
	.object({ field: fieldName, value: z.string().max(1_000) })
	.meta({ id: "AssistantFieldValue" });

export type AssistantFieldValue = z.infer<typeof AssistantFieldValueSchema>;

export const AssistantUnexpectedValuesSchema = z
	.object({
		values: z.array(AssistantFieldValueSchema),
		/** More observed than retained. */
		capped: z.boolean(),
	})
	.meta({ id: "AssistantUnexpectedValues" });

export type AssistantUnexpectedValues = z.infer<typeof AssistantUnexpectedValuesSchema>;

/** Older phones offer `drop`. */
const RuleActionSchema = z.enum(RULE_ACTIONS, { error: "unknown rule action; update the app" });

export const AssistantRuleConditionSchema = z
	.object({
		field: z.string().min(1).max(64),
		test: z.enum(RULE_TESTS),
		value: z.string().min(1).max(ASSISTANT_RULE_VALUE_MAX),
	})
	.meta({ id: "AssistantRuleCondition" });

/** Every condition holds, or the rule does not match. */
export const AssistantRuleSchema = z
	.object({
		id: z.string().regex(RULE_ID_RE),
		conditions: z.array(AssistantRuleConditionSchema).min(1).max(ASSISTANT_RULE_CONDITIONS_MAX),
		action: RuleActionSchema,
		/** Gateway-named; a put carries the one it read, 0 adds. */
		revision: z.number().int().nonnegative(),
	})
	.meta({ id: "AssistantRule" });

export const AssistantRuleOtherwiseSchema = z
	.object({
		action: RuleActionSchema,
		revision: z.number().int().nonnegative(),
	})
	.meta({ id: "AssistantRuleOtherwise" });

export const AssistantWatcherRulesSchema = z
	.object({
		rules: z.array(AssistantRuleSchema).max(ASSISTANT_RULES_MAX),
		otherwise: AssistantRuleOtherwiseSchema,
		/** Moves with every change; a sort names it. */
		revision: z.number().int().nonnegative(),
	})
	.meta({ id: "AssistantWatcherRules" });

export type AssistantRuleCondition = z.infer<typeof AssistantRuleConditionSchema>;
export type AssistantRule = z.infer<typeof AssistantRuleSchema>;
export type AssistantRuleOtherwise = z.infer<typeof AssistantRuleOtherwiseSchema>;
export type AssistantWatcherRules = z.infer<typeof AssistantWatcherRulesSchema>;

export const DEFAULT_RULES: AssistantWatcherRules = {
	rules: [],
	otherwise: { action: "inbox", revision: 0 },
	revision: 0,
};

/** Spec-invalid rules derive on read, never stored. */
export const AssistantRuleInvalidSchema = z
	.object({ id: z.string(), reason: z.string() })
	.meta({ id: "AssistantRuleInvalid" });

export type AssistantRuleInvalid = z.infer<typeof AssistantRuleInvalidSchema>;

/** Every rule op's answer: the held list, stored or not, so the phone decides from it. */
export const ConsoleAssistantRulesResultSchema = z
	.object({
		stored: z.boolean(),
		rules: AssistantWatcherRulesSchema,
		reason: z.string().optional(),
		invalid: z.array(AssistantRuleInvalidSchema).optional(),
	})
	.meta({ id: "ConsoleAssistantRulesResult" });

export type ConsoleAssistantRulesResult = z.infer<typeof ConsoleAssistantRulesResultSchema>;

export const ConsoleAssistantPreviewResultSchema = z
	.object({
		/** Events this rule decides from its place. */
		decided: z.number().int().nonnegative(),
		/** Matched, but an earlier rule decides. */
		shadowed: z.number().int().nonnegative(),
		of: z.number().int().nonnegative(),
		/** The first few decided, newest first. */
		titles: z.array(z.string()),
	})
	.meta({ id: "ConsoleAssistantPreviewResult" });

export type ConsoleAssistantPreviewResult = z.infer<typeof ConsoleAssistantPreviewResultSchema>;

/** Values trimmed; a rule is stored as it will be read. */
export function canonicalRule<T extends AssistantRule>(rule: T): T {
	return {
		...rule,
		conditions: rule.conditions.map((condition) => ({ ...condition, value: condition.value.trim() })),
	};
}

type RuleContent = Pick<AssistantRule, "action"> & { conditions?: AssistantRule["conditions"] };

const contentKey = (rule: RuleContent) =>
	JSON.stringify([
		rule.action,
		(rule.conditions ?? []).map((condition) => [condition.field, condition.test, condition.value]),
	]);

/** What a rule says, apart from its id and revision. */
export function sameContent(a: RuleContent, b: RuleContent): boolean {
	return contentKey(a) === contentKey(b);
}

const specOf = (specs: readonly AssistantFieldSpec[], field: string) => specs.find((spec) => spec.field === field);

function conditionIssue(condition: AssistantRuleCondition, specs: readonly AssistantFieldSpec[]): string | null {
	const spec = specOf(specs, condition.field);
	if (!spec) return `the rule uses unknown field "${condition.field}"`;
	if (condition.value.trim() === "") return `the rule has no value for ${spec.label}`;
	if (!testsOf(spec).includes(condition.test)) return `${spec.label} takes no "${condition.test}" test`;
	if (spec.kind === "enumeration" && !spec.options.some((option) => option.value === condition.value)) {
		return `"${condition.value}" is not a ${spec.label} choice`;
	}
	return null;
}

export type RuleParse = { ok: true; rule: AssistantRule } | { ok: false; reason: string };

/** Put, preview, and match share validation. */
export function parseRuleForFields(rule: AssistantRule, specs: readonly AssistantFieldSpec[]): RuleParse {
	const canonical = canonicalRule(rule);
	for (const condition of canonical.conditions) {
		const issue = conditionIssue(condition, specs);
		if (issue) return { ok: false, reason: issue };
	}
	return { ok: true, rule: canonical };
}

export function invalidRules(
	rules: readonly AssistantRule[],
	specs: readonly AssistantFieldSpec[],
): AssistantRuleInvalid[] {
	return rules.flatMap((rule) => {
		const parsed = parseRuleForFields(rule, specs);
		return parsed.ok ? [] : [{ id: rule.id, reason: parsed.reason }];
	});
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

/** Invalid rules never match. */
export function ruleMatches(
	rule: AssistantRule,
	specs: readonly AssistantFieldSpec[],
	fields: Readonly<Record<string, string>>,
): boolean {
	const parsed = parseRuleForFields(rule, specs);
	if (!parsed.ok) return false;
	// The canonical form, so a rule that parses is the one that matches.
	return parsed.rule.conditions.every((condition) => {
		const spec = specOf(specs, condition.field);
		return spec !== undefined && holds(condition, spec, fields);
	});
}

/** The one reading of which rule decides an event; the sort, the listing and the preview take it. */
export function firstMatch<T extends AssistantRule>(
	rules: readonly T[],
	specs: readonly AssistantFieldSpec[],
	fields: Readonly<Record<string, string>>,
): T | undefined {
	return rules.find((rule) => ruleMatches(rule, specs, fields));
}

/** Nothing matching takes `otherwise`. */
export function decideEvent(
	rules: AssistantWatcherRules,
	specs: readonly AssistantFieldSpec[],
	fields: Readonly<Record<string, string>>,
): RuleAction {
	return (firstMatch(rules.rules, specs, fields) ?? rules.otherwise).action;
}
