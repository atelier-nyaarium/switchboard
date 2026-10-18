// Watcher rules: ordered, first match wins.

import { z } from "zod";

export const RULE_TESTS = ["is", "is_not", "contains"] as const;
export const RULE_ACTIONS = ["wake", "inbox", "drop"] as const;
export const MAX_RULES = 50;
export const MAX_CONDITIONS = 8;

export type RuleAction = (typeof RULE_ACTIONS)[number];

export const AssistantRuleConditionSchema = z
	.object({
		field: z.string().min(1).max(64),
		test: z.enum(RULE_TESTS),
		value: z.string().min(1).max(200),
	})
	.meta({ id: "AssistantRuleCondition" });

/** Every condition holds, or the rule does not match. */
export const AssistantRuleSchema = z
	.object({
		conditions: z.array(AssistantRuleConditionSchema).min(1).max(MAX_CONDITIONS),
		action: z.enum(RULE_ACTIONS),
		/** Absent uses the default. */
		ping: z.boolean().optional(),
	})
	.meta({ id: "AssistantRule" });

export const AssistantRuleOtherwiseSchema = z
	.object({ action: z.enum(RULE_ACTIONS), ping: z.boolean().optional() })
	.meta({ id: "AssistantRuleOtherwise" });

export const AssistantWatcherRulesSchema = z
	.object({
		rules: z.array(AssistantRuleSchema).max(MAX_RULES),
		otherwise: AssistantRuleOtherwiseSchema,
		/** 0 means never saved. */
		revision: z.number().int().nonnegative(),
	})
	.meta({ id: "AssistantWatcherRules" });

export type AssistantRuleCondition = z.infer<typeof AssistantRuleConditionSchema>;
export type AssistantRule = z.infer<typeof AssistantRuleSchema>;
export type AssistantRuleOtherwise = z.infer<typeof AssistantRuleOtherwiseSchema>;
export type AssistantWatcherRules = z.infer<typeof AssistantWatcherRulesSchema>;

export const DEFAULT_RULES: AssistantWatcherRules = { rules: [], otherwise: { action: "inbox" }, revision: 0 };

/** One event's decision, kept on its row. */
export const RuleDecisionSchema = z.strictObject({
	action: z.enum(RULE_ACTIONS),
	ping: z.boolean(),
	rulesRevision: z.number().int().nonnegative(),
});

export type RuleDecision = z.infer<typeof RuleDecisionSchema>;

export const ConsoleAssistantPreviewResultSchema = z
	.object({
		/** Events this rule decides. */
		matched: z.number().int().nonnegative(),
		/** Matched, but an earlier rule decides. */
		earlier: z.number().int().nonnegative(),
		of: z.number().int().nonnegative(),
		/** The first few matched, newest first. */
		titles: z.array(z.string()),
	})
	.meta({ id: "ConsoleAssistantPreviewResult" });

export type ConsoleAssistantPreviewResult = z.infer<typeof ConsoleAssistantPreviewResultSchema>;

/** A drop never pings, so it keeps no override. */
export function canonicalOtherwise<T extends AssistantRuleOtherwise>(rule: T): T {
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

const ruleKey = (rule: AssistantRule | AssistantRuleOtherwise): string =>
	JSON.stringify([
		rule.action,
		rule.ping ?? null,
		"conditions" in rule
			? rule.conditions.map((condition) => [condition.field, condition.test, condition.value])
			: [],
	]);

type RuleList = Pick<AssistantWatcherRules, "rules" | "otherwise">;

/** Field by field, so key order and an absent ping read alike. */
export function sameRules(a: RuleList, b: RuleList): boolean {
	return (
		a.rules.length === b.rules.length &&
		ruleKey(a.otherwise) === ruleKey(b.otherwise) &&
		a.rules.every((rule, index) => {
			const other = b.rules[index];
			return other !== undefined && ruleKey(rule) === ruleKey(other);
		})
	);
}

/** Why rules cannot be stored, or null. */
export function rulesRefusal(rules: readonly AssistantRule[], fields: readonly string[]): string | null {
	for (const [index, rule] of rules.entries()) {
		for (const condition of rule.conditions) {
			if (!fields.includes(condition.field)) return `rule ${index + 1} uses unknown field "${condition.field}"`;
			if (condition.value.trim() === "") return `rule ${index + 1} has no value for "${condition.field}"`;
		}
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

/** The first rule that matches decides; nothing matching takes `otherwise`. */
export function decideEvent(
	rules: AssistantWatcherRules,
	fields: Readonly<Record<string, string>>,
	pingDefault: boolean,
): RuleDecision {
	const hit = rules.rules.find((rule) => ruleMatches(rule, fields)) ?? rules.otherwise;
	// A drop never pings.
	const ping = hit.action !== "drop" && (hit.ping ?? pingDefault);
	return { action: hit.action, ping, rulesRevision: rules.revision };
}
