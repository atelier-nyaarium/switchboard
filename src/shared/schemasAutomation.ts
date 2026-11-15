// One automation: a trigger and what it does.

import { z } from "zod";
import { AssistantRuleConditionSchema, RULE_ID_RE } from "./schemasAssistantRules.js";
import { ASSISTANT_RULE_CONDITIONS_MAX } from "./wire-vocabulary.js";

export const AUTOMATIONS_MAX = 64;
export const AUTOMATION_ACTIONS_MAX = 8;

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const TELL_WHEN = ["now", "quietly"] as const;
export type TellWhen = (typeof TELL_WHEN)[number];

const ConditionSchema = z.strictObject(AssistantRuleConditionSchema.shape);

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
	/** Every condition holds; none takes every event. */
	z.strictObject({
		kind: z.literal("event"),
		source: z.string().regex(SOURCE_ID_RE),
		conditions: z.array(ConditionSchema).max(ASSISTANT_RULE_CONDITIONS_MAX),
	}),
	/** A choice or boolean field becomes a value. */
	z.strictObject({
		kind: z.literal("value"),
		field: z.string().regex(RULE_ID_RE),
		becomes: z.union([z.string().min(1).max(256), z.boolean()]),
		coolDownSec: z.number().int().min(0).max(86_400),
	}),
]);

export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;
export type EventTrigger = Extract<AutomationTrigger, { kind: "event" }>;
export type ValueTrigger = Extract<AutomationTrigger, { kind: "value" }>;

export const AutomationActionSchema = z.discriminatedUnion("kind", [
	/** Now wakes; quietly waits in the inbox. */
	z.strictObject({ kind: z.literal("tell_assistant"), when: z.enum(TELL_WHEN) }),
]);

export type AutomationAction = z.infer<typeof AutomationActionSchema>;

export const AutomationSchema = z.strictObject({
	/** A projection's own sentence. */
	label: z.string().min(1).max(80).optional(),
	enabled: z.boolean(),
	trigger: AutomationTriggerSchema,
	actions: z.array(AutomationActionSchema).min(1).max(AUTOMATION_ACTIONS_MAX),
});

export type Automation = z.infer<typeof AutomationSchema>;

/** Now outranks quietly. */
export function tellWhen(automation: Pick<Automation, "actions">): TellWhen | null {
	const told = automation.actions.filter((action) => action.kind === "tell_assistant");
	if (told.length === 0) return null;
	return told.some((action) => action.when === "now") ? "now" : "quietly";
}
