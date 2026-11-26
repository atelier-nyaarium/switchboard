// Saving an automation with the function it runs, and why a save is refused.

import { z } from "zod";
import { RULE_ID_RE } from "./schemasAssistantRules.js";
import {
	AUTOMATIONS_MAX,
	AutomationFunctionRowSchema,
	AutomationRowSchema,
	AutomationSchema,
	FunctionReadsSchema,
} from "./schemasAutomation.js";
import { FunctionSchema } from "./schemasFunction.js";

export const AUTOMATION_SAVE_REFUSALS = [
	/** `record`, `revision` held now. */
	"moved",
	/** `record`. */
	"gone",
	/** `max`; `kind` for a kind's cap, absent for the total. */
	"full",
	/** `record`, `path`. */
	"invalid",
	/** `record`, `path`, `param`, `start`, `end`. */
	"hole",
	/** `automations` that stop fitting. */
	"unfit",
	/** `id`. */
	"unknown_function",
	"mixed",
	"newer_app",
	"not_home",
	/** `labels` to confirm. */
	"confirm",
	/** Trigger has its own cool-down. */
	"cool_down_twice",
	/** `record`, `id`: held by a newer build. */
	"newer_function",
	/** Its derived id's key is unreadable. */
	"no_key",
	/** The disk refused it. */
	"unwritten",
	/** `id`: an automation row held by a newer build. */
	"newer_automation",
	/** Every derived id it may take is held. */
	"no_free_id",
] as const;
export type AutomationSaveRefusalCode = (typeof AUTOMATION_SAVE_REFUSALS)[number];

export const SAVE_RECORDS = ["automation", "function"] as const;
export const SAVE_LINE_MAX = 400;

export const AutomationSaveRefusalSchema = z
	.object({
		code: z.enum(AUTOMATION_SAVE_REFUSALS),
		record: z.enum(SAVE_RECORDS).optional(),
		revision: z.number().int().nonnegative().optional(),
		kind: z.enum(SAVE_RECORDS).optional(),
		max: z.number().int().positive().optional(),
		path: z.string().max(64).optional(),
		param: z.string().max(32).optional(),
		start: z.number().int().nonnegative().optional(),
		end: z.number().int().nonnegative().optional(),
		automations: z.array(z.string()).max(AUTOMATIONS_MAX).optional(),
		labels: z.array(z.string().max(80)).max(32).optional(),
		id: z.string().optional(),
		/** Shown as written, as a row's `invalid`; never decided from. */
		line: z.string().max(SAVE_LINE_MAX).optional(),
	})
	.meta({ id: "AutomationSaveRefusal" });
export type AutomationSaveRefusal = z.infer<typeof AutomationSaveRefusalSchema>;

export const AutomationSaveFunctionSchema = z
	.discriminatedUnion("as", [
		/** Existing, or new. */
		z.strictObject({
			as: z.literal("edit"),
			id: z.string().regex(RULE_ID_RE),
			body: FunctionSchema,
			base: z.number().int().nonnegative(),
		}),
		/** Gateway-named copy, repointed. */
		z.strictObject({
			as: z.literal("copy"),
			from: z.string().regex(RULE_ID_RE),
			fromBase: z.number().int().positive(),
			body: FunctionSchema,
		}),
	])
	.meta({ id: "AutomationSaveFunction" });

export const AutomationSaveOpShape = {
	kind: z.literal("automation_save"),
	automationId: z.string().regex(RULE_ID_RE),
	automation: AutomationSchema,
	/** 0 adds. */
	automationBase: z.number().int().nonnegative(),
	/** Absent: flat or unchanged. */
	function: AutomationSaveFunctionSchema.optional(),
	/** Its function's revision as shown. */
	functionBase: z.number().int().positive().optional(),
	/** Owner confirmed. */
	confirmed: z.boolean().optional(),
};

/** A save, judged only. */
export const AutomationCheckOpShape = { ...AutomationSaveOpShape, kind: z.literal("automation_check") };

/** A save's answer, unwritten. */
export const ConsoleAutomationCheckResultSchema = z
	.object({
		ready: z.boolean(),
		refusal: AutomationSaveRefusalSchema.optional(),
		/** Its body's reads. */
		reads: FunctionReadsSchema.optional(),
	})
	.meta({ id: "ConsoleAutomationCheckResult" });
export type ConsoleAutomationCheckResult = z.infer<typeof ConsoleAutomationCheckResultSchema>;

export const ConsoleAutomationSaveResultSchema = z
	.object({
		stored: z.boolean(),
		automation: AutomationRowSchema.optional(),
		function: AutomationFunctionRowSchema.optional(),
		refusal: AutomationSaveRefusalSchema.optional(),
	})
	.meta({ id: "ConsoleAutomationSaveResult" });
export type ConsoleAutomationSaveResult = z.infer<typeof ConsoleAutomationSaveResultSchema>;
