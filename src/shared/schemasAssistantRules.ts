// Watcher rules: ordered, first match wins.

import { z } from "zod";
import { ASSISTANT_RULE_CONDITIONS_MAX, ASSISTANT_RULE_VALUE_MAX, ASSISTANT_RULES_MAX } from "./wire-vocabulary.js";

export const RULE_TESTS = ["is", "is_not", "contains"] as const;
export const RULE_ACTIONS = ["wake", "inbox", "drop"] as const;
/** The phone mints it; the Gateway keeps it. */
export const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type RuleAction = (typeof RULE_ACTIONS)[number];

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
		action: z.enum(RULE_ACTIONS),
		/** Absent uses the default. */
		ping: z.boolean().optional(),
		/** Gateway-named; a put carries the one it read, 0 adds. */
		revision: z.number().int().nonnegative(),
	})
	.meta({ id: "AssistantRule" });

export const AssistantRuleOtherwiseSchema = z
	.object({
		action: z.enum(RULE_ACTIONS),
		ping: z.boolean().optional(),
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

/** One event's decision, kept on its row. */
export const RuleDecisionSchema = z.strictObject({
	action: z.enum(RULE_ACTIONS),
	ping: z.boolean(),
	rulesRevision: z.number().int().nonnegative(),
});

export type RuleDecision = z.infer<typeof RuleDecisionSchema>;

/** Every rule op's answer: the held list, stored or not, so the phone decides from it. */
export const ConsoleAssistantRulesResultSchema = z
	.object({
		stored: z.boolean(),
		rules: AssistantWatcherRulesSchema,
		reason: z.string().optional(),
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

/** A drop never pings, so it keeps no override. */
export function canonicalOtherwise<T extends Pick<AssistantRuleOtherwise, "action" | "ping">>(rule: T): T {
	if (rule.action !== "drop" || rule.ping === undefined) return rule;
	const { ping: _ping, ...kept } = rule;
	return kept as T;
}

/** Values trimmed; a rule is stored as it will be read. */
export function canonicalRule<T extends AssistantRule>(rule: T): T {
	return canonicalOtherwise({
		...rule,
		conditions: rule.conditions.map((condition) => ({ ...condition, value: condition.value.trim() })),
	});
}

const contentKey = (rule: Pick<AssistantRule, "action" | "ping"> & { conditions?: AssistantRule["conditions"] }) =>
	JSON.stringify([
		rule.action,
		rule.ping ?? null,
		(rule.conditions ?? []).map((condition) => [condition.field, condition.test, condition.value]),
	]);

/** What a rule says, apart from its id and revision. */
export function sameContent(
	a: Pick<AssistantRule, "action" | "ping"> & { conditions?: AssistantRule["conditions"] },
	b: Pick<AssistantRule, "action" | "ping"> & { conditions?: AssistantRule["conditions"] },
): boolean {
	return contentKey(a) === contentKey(b);
}

/** Why a rule cannot be stored, or null. */
export function ruleRefusal(rule: AssistantRule, fields: readonly string[]): string | null {
	for (const condition of rule.conditions) {
		if (!fields.includes(condition.field)) return `the rule uses unknown field "${condition.field}"`;
		if (condition.value.trim() === "") return `the rule has no value for "${condition.field}"`;
	}
	return null;
}

const holds = (condition: AssistantRuleCondition, fields: Readonly<Record<string, string>>): boolean => {
	const actual = (Object.hasOwn(fields, condition.field) ? fields[condition.field] : "")?.toLowerCase() ?? "";
	const wanted = condition.value.toLowerCase();
	if (condition.test === "is") return actual === wanted;
	if (condition.test === "is_not") return actual !== wanted;
	return actual.includes(wanted);
};

/** Case does not count. */
export function ruleMatches(rule: AssistantRule, fields: Readonly<Record<string, string>>): boolean {
	return rule.conditions.every((condition) => holds(condition, fields));
}

/** The one reading of which rule decides an event; the sort and the preview both take it. */
export function firstMatch<T extends AssistantRule>(
	rules: readonly T[],
	fields: Readonly<Record<string, string>>,
): T | undefined {
	return rules.find((rule) => ruleMatches(rule, fields));
}

/** Nothing matching takes `otherwise`. */
export function decideEvent(
	rules: AssistantWatcherRules,
	fields: Readonly<Record<string, string>>,
	pingDefault: boolean,
): RuleDecision {
	const hit = firstMatch(rules.rules, fields) ?? rules.otherwise;
	// A drop never pings.
	const ping = hit.action !== "drop" && (hit.ping ?? pingDefault);
	return { action: hit.action, ping, rulesRevision: rules.revision };
}
