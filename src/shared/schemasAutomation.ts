// One automation: a trigger and what it does.

import { z } from "zod";
import {
	AssistantRuleConditionSchema,
	type AssistantWatcherRules,
	canonicalConditions,
	RULE_ID_RE,
} from "./schemasAssistantRules.js";
import { ASSISTANT_RULE_CONDITIONS_MAX, ASSISTANT_RULES_MAX } from "./wire-vocabulary.js";

export const AUTOMATIONS_MAX = 64;
export const AUTOMATION_ACTIONS_MAX = 8;

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const TELL_WHEN = ["now", "quietly"] as const;
export type TellWhen = (typeof TELL_WHEN)[number];

export const AutomationConditionSchema = z
	.strictObject(AssistantRuleConditionSchema.shape)
	.meta({ id: "AutomationCondition" });

export const AutomationTriggerSchema = z
	.discriminatedUnion("kind", [
		/** Every condition holds; none takes every event. */
		z.strictObject({
			kind: z.literal("event"),
			source: z.string().regex(SOURCE_ID_RE),
			conditions: z.array(AutomationConditionSchema).max(ASSISTANT_RULE_CONDITIONS_MAX),
		}),
		/** A choice or boolean field becomes a value. */
		z.strictObject({
			kind: z.literal("value"),
			field: z.string().regex(RULE_ID_RE),
			becomes: z.union([z.string().min(1).max(256), z.boolean()]),
			coolDownSec: z.number().int().min(0).max(86_400),
		}),
	])
	.meta({ id: "AutomationTrigger" });

export type AutomationCondition = z.infer<typeof AutomationConditionSchema>;
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;
export type EventTrigger = Extract<AutomationTrigger, { kind: "event" }>;
export type ValueTrigger = Extract<AutomationTrigger, { kind: "value" }>;

export const AutomationActionSchema = z
	.discriminatedUnion("kind", [
		/** Now wakes; quietly waits in the inbox. */
		z.strictObject({ kind: z.literal("tell_assistant"), when: z.enum(TELL_WHEN) }),
	])
	.meta({ id: "AutomationAction" });

export type AutomationAction = z.infer<typeof AutomationActionSchema>;

export const AutomationSchema = z
	.strictObject({
		/** A projection's own sentence; a sealed payload holds null. */
		label: z.string().min(1).max(80).nullish(),
		enabled: z.boolean(),
		trigger: AutomationTriggerSchema,
		actions: z.array(AutomationActionSchema).min(1).max(AUTOMATION_ACTIONS_MAX),
	})
	.meta({ id: "Automation" });

export type Automation = z.infer<typeof AutomationSchema>;

/** Now outranks quietly. */
export function tellWhen(automation: Pick<Automation, "actions">): TellWhen | null {
	const told = automation.actions.filter((action) => action.kind === "tell_assistant");
	if (told.length === 0) return null;
	return told.some((action) => action.when === "now") ? "now" : "quietly";
}

/** As stored and matched: no null label, event conditions trimmed. */
export function canonicalAutomation(automation: Automation): Automation {
	const { label, ...rest } = automation;
	const body: Automation = label ? automation : rest;
	const { trigger } = body;
	if (trigger.kind !== "event") return body;
	return { ...body, trigger: { ...trigger, conditions: canonicalConditions(trigger.conditions) } };
}

export const CarriedAutomationSchema = z
	.object({ id: z.string().regex(RULE_ID_RE), automation: AutomationSchema })
	.meta({ id: "CarriedAutomation" });

export type CarriedAutomation = z.infer<typeof CarriedAutomationSchema>;

// Remove 2026-11-28 with the stored rules.
/** Each rule that woke, as an automation under its id. */
export function automationsOfRules(sourceId: string, held: AssistantWatcherRules): CarriedAutomation[] {
	const wake = (conditions: EventTrigger["conditions"]): Automation => ({
		enabled: true,
		trigger: { kind: "event", source: sourceId, conditions: canonicalConditions(conditions) },
		actions: [{ kind: "tell_assistant", when: "now" }],
	});
	const carried = held.rules
		.filter((rule) => rule.action === "wake")
		.map((rule) => ({ id: rule.id, automation: wake(rule.conditions) }));
	if (held.otherwise.action !== "wake") return carried;
	return [...carried, { id: `every-${sourceId}`.slice(0, 64), automation: wake([]) }];
}

// Remove 2026-11-28 with the stored rules.
/** What wakes now, as an older phone reads and carries it. */
export function rulesOfAutomations(
	armed: readonly { id: string; trigger: EventTrigger; when: TellWhen | null }[],
): AssistantWatcherRules {
	const waking = armed.filter((event) => event.when === "now");
	const every = waking.some((event) => event.trigger.conditions.length === 0);
	return {
		rules: waking
			.filter((event) => event.trigger.conditions.length > 0)
			.slice(0, ASSISTANT_RULES_MAX)
			.map((event) => ({ id: event.id, conditions: event.trigger.conditions, action: "wake", revision: 0 })),
		otherwise: { action: every ? "wake" : "inbox", revision: 0 },
		revision: 0,
	};
}

/** One automation as its Gateway lists it. */
export const AutomationRowSchema = z
	.object({
		id: z.string().regex(RULE_ID_RE),
		/** Gateway-named; a put carries the one it read, 0 adds. */
		revision: z.number().int().nonnegative(),
		automation: AutomationSchema,
		/** Written from the trigger. */
		sentence: z.string().max(400),
		/** Why it cannot run. */
		invalid: z.string().optional(),
		lastRanAt: z.number().int().optional(),
		/** The device whose Alerts row wrote it. */
		device: z.string().optional(),
	})
	.meta({ id: "AutomationRow" });

export type AutomationRow = z.infer<typeof AutomationRowSchema>;

export const ConsoleAutomationListResultSchema = z
	.object({ automations: z.array(AutomationRowSchema) })
	.meta({ id: "ConsoleAutomationListResult" });

export const ConsoleAutomationPutResultSchema = z
	.object({
		stored: z.boolean(),
		/** Held after the write. */
		revision: z.number().int().nonnegative(),
		/** Adopted by the phone. */
		row: AutomationRowSchema.optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "ConsoleAutomationPutResult" });

export const ConsoleAutomationDeleteResultSchema = z
	.object({ deleted: z.boolean(), reason: z.string().optional() })
	.meta({ id: "ConsoleAutomationDeleteResult" });

export const AUTOMATION_PREVIEW_EVENTS = 50;
export const AUTOMATION_PREVIEW_SHOWN = 10;

/** What an event trigger would have matched. */
export const ConsoleAutomationPreviewResultSchema = z
	.object({
		matched: z.number().int().nonnegative(),
		of: z.number().int().nonnegative(),
		/** Newest first. */
		matches: z
			.array(z.object({ title: z.string(), at: z.number().int() }).meta({ id: "AutomationPreviewMatch" }))
			.max(AUTOMATION_PREVIEW_SHOWN),
	})
	.meta({ id: "ConsoleAutomationPreviewResult" });

export type ConsoleAutomationListResult = z.infer<typeof ConsoleAutomationListResultSchema>;
export type ConsoleAutomationPutResult = z.infer<typeof ConsoleAutomationPutResultSchema>;
export type ConsoleAutomationDeleteResult = z.infer<typeof ConsoleAutomationDeleteResultSchema>;
export type ConsoleAutomationPreviewResult = z.infer<typeof ConsoleAutomationPreviewResultSchema>;
