// One automation: a trigger and what it does.

import { z } from "zod";
import { reached, walked } from "./automation-walk.js";
import {
	AssistantRuleConditionSchema,
	type AssistantWatcherRules,
	canonicalConditions,
	RULE_ID_RE,
} from "./schemasAssistantRules.js";
import { DeviceVerbSchema } from "./schemasDevices.js";
import { PARAM_NAME_RE, STEP_TEXT_MAX } from "./schemasFunction.js";
import { ASSISTANT_RULE_CONDITIONS_MAX, ASSISTANT_RULES_MAX } from "./wire-vocabulary.js";

export const AUTOMATIONS_MAX = 64;
export const AUTOMATION_ACTIONS_MAX = 8;
export const AUTOMATION_MESSAGE_MAX = 1_000;
const IFTTT_VALUE_MAX = 500;
const IFTTT_EVENT_MAX = 80;
/** A `word` parameter. */
export const ACTION_WORD_RE = /^[A-Za-z0-9_-]+$/;
/** A week. */
export const AUTOMATION_INTERVAL_MAX_MIN = 10_080;
export const AUTOMATION_COOL_DOWN_MAX_SEC = 86_400;
/** Per-step window, minutes. */
export const KEEP_TRYING_MIN_DEFAULT = 10;
export const KEEP_TRYING_MIN_MIN = 1;
export const KEEP_TRYING_MIN_MAX = 60;

/** Number in the stored unit. */
export const FunctionValueSchema = z.union([z.string().max(STEP_TEXT_MAX), z.number().finite()]);
export type FunctionValue = z.infer<typeof FunctionValueSchema>;

export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const TELL_WHEN = ["now", "quietly"] as const;
export type TellWhen = (typeof TELL_WHEN)[number];

export const CROSSING_DIRECTIONS = ["above", "below"] as const;
export type CrossingDirection = (typeof CROSSING_DIRECTIONS)[number];

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
			coolDownSec: z.number().int().min(0).max(AUTOMATION_COOL_DOWN_MAX_SEC),
		}),
		/** A device's number crosses a threshold. */
		z.strictObject({
			kind: z.literal("crossing"),
			device: z.string().min(1).max(64),
			measure: z.string().min(1).max(64),
			direction: z.enum(CROSSING_DIRECTIONS),
			threshold: z.number(),
			/** Clears this far back. */
			deadZone: z.number().nonnegative(),
			coolDownSec: z.number().int().min(0).max(AUTOMATION_COOL_DOWN_MAX_SEC),
		}),
		/** A local time on its weekdays. */
		z.strictObject({
			kind: z.literal("time"),
			/** HH:MM, read in `zone`. */
			time: z.string().regex(/^\d{2}:\d{2}$/),
			/** ISO weekdays; Monday is 1. */
			weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
			zone: z.string().min(1).max(64),
		}),
		/** Counted from when it last came round. */
		z.strictObject({
			kind: z.literal("interval"),
			everyMin: z.number().int().min(1).max(AUTOMATION_INTERVAL_MAX_MIN),
		}),
	])
	.meta({ id: "AutomationTrigger" });

export type AutomationCondition = z.infer<typeof AutomationConditionSchema>;
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;
export type EventTrigger = Extract<AutomationTrigger, { kind: "event" }>;
export type ValueTrigger = Extract<AutomationTrigger, { kind: "value" }>;
export type CrossingTrigger = Extract<AutomationTrigger, { kind: "crossing" }>;
export type ClockTrigger = Extract<AutomationTrigger, { kind: "time" | "interval" }>;

export const AutomationActionSchema = z
	.discriminatedUnion("kind", [
		/** Now wakes; quietly waits in the inbox. */
		z.strictObject({
			kind: z.literal("tell_assistant"),
			when: z.enum(TELL_WHEN),
			/** Text with `{expression}` holes. */
			message: z.string().min(1).max(AUTOMATION_MESSAGE_MAX).optional(),
		}),
		/** A switch this Gateway holds. */
		z.strictObject({ kind: z.literal("device_set"), device: z.string().min(1).max(64), verb: DeviceVerbSchema }),
		/** Its own shape, so tightening the live request leaves a stored row readable. */
		z.strictObject({
			kind: z.literal("ifttt_trigger"),
			event: z.string().min(1).max(IFTTT_EVENT_MAX).regex(ACTION_WORD_RE),
			value1: z.string().max(IFTTT_VALUE_MAX).optional(),
			value2: z.string().max(IFTTT_VALUE_MAX).optional(),
			value3: z.string().max(IFTTT_VALUE_MAX).optional(),
		}),
		/** A pointer, never an effect. */
		z.strictObject({
			kind: z.literal("run_function"),
			function: z.string().regex(RULE_ID_RE),
			/** Keyed by value name. */
			values: z.record(z.string().regex(PARAM_NAME_RE), FunctionValueSchema).optional(),
			/** Per-step window. */
			keepTryingMin: z.number().int().min(KEEP_TRYING_MIN_MIN).max(KEEP_TRYING_MIN_MAX).optional(),
			/** Only if trigger has none. */
			coolDownSec: z.number().int().nonnegative().max(AUTOMATION_COOL_DOWN_MAX_SEC).optional(),
		}),
	])
	.meta({ id: "AutomationAction" });

export type AutomationAction = z.infer<typeof AutomationActionSchema>;
export type AutomationActionKind = AutomationAction["kind"];

/** How a parameter is filled in. */
export const ACTION_PARAM_KINDS = ["text", "word", "switch", "choice", "function", "values"] as const;
export type ActionParamKind = (typeof ACTION_PARAM_KINDS)[number];

export interface AutomationActionParam {
	/** The action's own key. */
	name: string;
	label: string;
	kind: ActionParamKind;
	/** A text's or a word's longest. */
	max?: number;
	/** A text that takes several lines. */
	lines?: boolean;
	optional?: boolean;
	options?: readonly { value: string; label: string }[];
}

export interface AutomationActionRow {
	label: string;
	/** Where its effect happens. */
	runs: "assistant" | "gateway";
	/** A save adding one is confirmed. */
	danger: boolean;
	/** Needs the assistant's home. */
	home: boolean;
	/** In the order an editor draws them. */
	params: readonly AutomationActionParam[];
	/** Never served. */
	undrawn?: readonly string[];
}

const optionsOf = (values: readonly string[]) =>
	values.map((value) => ({ value, label: value.replace(/^./, (first) => first.toUpperCase()) }));

const iftttValue = (at: number): AutomationActionParam => ({
	name: `value${at}`,
	label: `Value ${at}`,
	kind: "text",
	max: IFTTT_VALUE_MAX,
	optional: true,
});

/** Every action an automation can run. */
export const AUTOMATION_ACTIONS = {
	tell_assistant: {
		label: "Tell the assistant",
		runs: "assistant",
		danger: false,
		home: true,
		params: [
			{ name: "when", label: "When", kind: "choice", options: optionsOf(TELL_WHEN) },
			{
				name: "message",
				label: "Message",
				kind: "text",
				max: AUTOMATION_MESSAGE_MAX,
				lines: true,
				optional: true,
			},
		],
	},
	device_set: {
		label: "Switch a plug",
		runs: "gateway",
		danger: false,
		home: false,
		params: [
			{ name: "device", label: "Plug", kind: "switch" },
			{ name: "verb", label: "Set", kind: "choice", options: optionsOf(DeviceVerbSchema.options) },
		],
	},
	ifttt_trigger: {
		label: "Send to IFTTT",
		runs: "gateway",
		danger: true,
		home: true,
		params: [
			{ name: "event", label: "Event name", kind: "word", max: IFTTT_EVENT_MAX },
			iftttValue(1),
			iftttValue(2),
			iftttValue(3),
		],
	},
	run_function: {
		label: "Run a function",
		runs: "gateway",
		// Its steps carry their own.
		danger: false,
		home: false,
		params: [
			{ name: "function", label: "Function", kind: "function" },
			{ name: "values", label: "Values", kind: "values", optional: true },
		],
		undrawn: ["keepTryingMin", "coolDownSec"],
	},
} as const satisfies Record<AutomationActionKind, AutomationActionRow>;

/** An action's texts that may hold holes, by parameter. */
export const actionTexts = (action: AutomationAction): { param: string; text: string }[] =>
	AUTOMATION_ACTIONS[action.kind].params.flatMap((param) => {
		const held = param.kind === "text" ? (action as Record<string, unknown>)[param.name] : undefined;
		return typeof held === "string" ? [{ param: param.name, text: held }] : [];
	});

export type AutomationTriggerKind = AutomationTrigger["kind"];

/** A name a trigger offers a hole. */
export interface AutomationTriggerName {
	name: string;
	/** As an editor lists it. */
	description: string;
}

const TIME_NAMES = [{ name: "time", description: "The time it came round" }];

export const AUTOMATION_TRIGGERS = {
	event: {
		names: [
			{ name: "event", description: "The event; its fields by name" },
			{ name: "source", description: "The source's name" },
		],
	},
	value: {
		names: [
			{ name: "value", description: "The value it became" },
			{ name: "field", description: "The field's name" },
		],
	},
	crossing: {
		names: [
			{ name: "value", description: "The reading now" },
			{ name: "device", description: "The device's name" },
			{ name: "measure", description: "What it measures" },
			{ name: "threshold", description: "The threshold" },
		],
	},
	time: { names: TIME_NAMES },
	interval: { names: TIME_NAMES },
} as const satisfies Record<AutomationTriggerKind, { names: readonly AutomationTriggerName[] }>;

const triggerNames = (kind: AutomationTriggerKind): readonly string[] =>
	AUTOMATION_TRIGGERS[kind].names.map((held) => held.name);

/** Names a trigger offers a hole. */
export const AUTOMATION_TRIGGER_NAMES: Readonly<Record<AutomationTriggerKind, readonly string[]>> = {
	event: triggerNames("event"),
	value: triggerNames("value"),
	crossing: triggerNames("crossing"),
	time: triggerNames("time"),
	interval: triggerNames("interval"),
};

export const dangerousActions = (automation: Pick<Automation, "actions">): AutomationAction[] =>
	reached(automation)
		.map(({ action }) => action)
		.filter((action) => AUTOMATION_ACTIONS[action.kind].danger);

export const AutomationSchema = z
	.strictObject({
		/** Replaces the row's sentence; a sealed payload holds null. */
		label: z.string().min(1).max(80).nullish(),
		enabled: z.boolean(),
		trigger: AutomationTriggerSchema,
		actions: walked(z.array(AutomationActionSchema).min(1).max(AUTOMATION_ACTIONS_MAX)),
	})
	.meta({ id: "Automation" });

/** Parsed: `actions` opens only through the walk. */
export type Automation = z.output<typeof AutomationSchema>;
/** What a writer builds, then parses. */
export type AutomationInput = z.input<typeof AutomationSchema>;

/** Now outranks quietly. */
export function tellWhenOf(actions: readonly AutomationAction[]): TellWhen | null {
	const told = actions.flatMap((action) => (action.kind === "tell_assistant" ? [action] : []));
	if (told.length === 0) return null;
	return told.some((action) => action.when === "now") ? "now" : "quietly";
}

export const tellWhen = (automation: Pick<Automation, "actions">): TellWhen | null =>
	tellWhenOf(reached(automation).map(({ action }) => action));

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
	const wake = (conditions: EventTrigger["conditions"]): Automation =>
		AutomationSchema.parse({
			enabled: true,
			trigger: { kind: "event", source: sourceId, conditions: canonicalConditions(conditions) },
			actions: [{ kind: "tell_assistant", when: "now" }],
		} satisfies AutomationInput);
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
		/** A time or interval trigger's next slot. */
		nextRunAt: z.number().int().optional(),
	})
	.meta({ id: "AutomationRow" });

export type AutomationRow = z.infer<typeof AutomationRowSchema>;

/** The kinds this Gateway's automations can hold. */
export const AUTOMATION_SERVES = {
	triggers: Object.entries(AUTOMATION_TRIGGERS).map(([kind, row]) => ({
		kind,
		names: row.names.map((held) => ({ ...held })),
	})),
	actions: Object.entries(AUTOMATION_ACTIONS).map(([kind, row]) => ({
		kind,
		label: row.label,
		danger: row.danger,
		home: row.home,
		params: (row.params as readonly AutomationActionParam[]).map(({ options, ...param }) => ({
			...param,
			...(options ? { options: [...options] } : {}),
		})),
	})),
};

/** One of an action's parameters, as an editor draws it. */
export const AutomationActionParamSchema = z
	.object({
		name: z.string().max(32),
		label: z.string().max(40),
		/** A kind an editor does not know leaves its action read-only. */
		kind: z.string().max(16),
		max: z.number().int().positive().optional(),
		lines: z.boolean().optional(),
		optional: z.boolean().optional(),
		options: z
			.array(
				z
					.object({ value: z.string().max(32), label: z.string().max(40) })
					.meta({ id: "AutomationActionOption" }),
			)
			.max(8)
			.optional(),
	})
	.meta({ id: "AutomationActionParam" });

const OFFERED_MAX = 256;

/** A trigger kind an editor may start, with the names a text's holes may use. */
export const AutomationTriggerOfferSchema = z
	.object({
		kind: z.string().max(32),
		names: z
			.array(
				z
					.object({ name: z.string().max(32), description: z.string().max(80) })
					.meta({ id: "AutomationTriggerName" }),
			)
			.max(16),
	})
	.meta({ id: "AutomationTriggerOffer" });
export type AutomationTriggerOffer = z.infer<typeof AutomationTriggerOfferSchema>;

/** A sensor's number a crossing can watch. */
export const AutomationNumberOfferSchema = z
	.object({
		device: z.string().max(64),
		measure: z.string().max(64),
		/** The device's name, then the measure's. */
		label: z.string().max(160),
		/** As stored; absent for a bare number. */
		unit: z.string().max(16).optional(),
		decimals: z.number().int().nonnegative().max(6),
	})
	.meta({ id: "AutomationNumberOffer" });
export type AutomationNumberOffer = z.infer<typeof AutomationNumberOfferSchema>;

/** A switch an action can set. */
export const AutomationSwitchOfferSchema = z
	.object({ device: z.string().max(64), name: z.string().max(80) })
	.meta({ id: "AutomationSwitchOffer" });
export type AutomationSwitchOffer = z.infer<typeof AutomationSwitchOfferSchema>;

export const ConsoleAutomationListResultSchema = z
	.object({
		automations: z.array(AutomationRowSchema),
		// Required from 2026-11-29.
		/** Absent from a build that holds an event trigger and a tell alone. */
		serves: z
			.object({
				triggers: z.array(AutomationTriggerOfferSchema).max(16),
				actions: z
					.array(
						z
							.object({
								kind: z.string().max(32),
								label: z.string().max(80),
								danger: z.boolean(),
								home: z.boolean(),
								params: z.array(AutomationActionParamSchema).max(16),
							})
							.meta({ id: "AutomationActionOffer" }),
					)
					.max(16),
				/** What this Gateway's devices offer a trigger and an action. */
				numbers: z.array(AutomationNumberOfferSchema).max(OFFERED_MAX),
				switches: z.array(AutomationSwitchOfferSchema).max(OFFERED_MAX),
			})
			.meta({ id: "AutomationServes" })
			.optional(),
	})
	.meta({ id: "ConsoleAutomationListResult" });

export const ConsoleAutomationPutResultSchema = z
	.object({
		stored: z.boolean(),
		/** Held after the write. */
		revision: z.number().int().nonnegative(),
		/** Adopted by the phone. */
		row: AutomationRowSchema.optional(),
		reason: z.string().optional(),
		/** Actions to confirm; send again with `confirmed`. */
		confirm: z.array(z.string().max(80)).max(AUTOMATION_ACTIONS_MAX).optional(),
		/** Refused hole location. */
		hole: z
			.object({
				action: z.number().int().nonnegative(),
				param: z.string().max(32),
				start: z.number().int().nonnegative(),
				end: z.number().int().nonnegative(),
			})
			.meta({ id: "AutomationHoleSpan" })
			.optional(),
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
		/** An event's names are its newest match's. */
		names: z
			.array(
				z
					.object({ name: z.string().max(32), shown: z.string().max(200) })
					.meta({ id: "AutomationPreviewName" }),
			)
			.max(16)
			.optional(),
		/** The text sent, with its holes filled from `names`. */
		filled: z.string().max(4_000).optional(),
		/** Why the text cannot be saved, and where. */
		hole: z
			.object({
				start: z.number().int().nonnegative(),
				end: z.number().int().nonnegative(),
				message: z.string().max(200),
			})
			.meta({ id: "AutomationPreviewHole" })
			.optional(),
	})
	.meta({ id: "ConsoleAutomationPreviewResult" });

export type ConsoleAutomationListResult = z.infer<typeof ConsoleAutomationListResultSchema>;
export type ConsoleAutomationPutResult = z.infer<typeof ConsoleAutomationPutResultSchema>;
export type ConsoleAutomationDeleteResult = z.infer<typeof ConsoleAutomationDeleteResultSchema>;
export type ConsoleAutomationPreviewResult = z.infer<typeof ConsoleAutomationPreviewResultSchema>;
