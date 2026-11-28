// Saving an automation with the function it runs, and why a save is refused.

import { z } from "zod";
import { STEP_PATH_RE } from "./automation-walk.js";
import { RULE_ID_RE } from "./schemasAssistantRules.js";
import {
	AUTOMATIONS_MAX,
	AutomationFunctionRowSchema,
	AutomationRowSchema,
	AutomationSchema,
	FunctionReadsSchema,
} from "./schemasAutomation.js";
import { FUNCTIONS_MAX, FunctionSchema } from "./schemasFunction.js";

export const AUTOMATION_SAVE_REFUSALS = [
	/** `record`, `revision` held now. */
	"changed",
	/** `record`. */
	"gone",
	/** `max`; `kind` for a kind's cap, absent for the total. */
	"full",
	/** `record`, `path`. */
	"invalid",
	/** `record`, `path`, `param`, `start`, `end`. */
	"placeholder", // skew:step-refusals
	/** `automations` that stop fitting. */
	"unfit", // skew:step-refusals
	/** `id`. */
	"unknown_function",
	"mixed",
	"newer_app",
	"not_home",
	/** `labels` to confirm. */
	"confirm",
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
	/** `id`: a function its calls reach again. */
	"loop",
	/** `id`: an unnamed function another automation runs, or a function runs. */
	"unnamed",
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
		/** The step it names, by the walk's numbers under `record`. */
		step: z.string().regex(STEP_PATH_RE).max(64).optional(),
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

/** Saved issue severity. */
export const AUTOMATION_ISSUE_LEVELS = [
	/** It never fires. */
	"inactive",
	/** Run fails here. */
	"error",
	/** It runs on. */
	"warning",
] as const;
export type AutomationIssueLevel = (typeof AUTOMATION_ISSUE_LEVELS)[number];

const CAUSE_LEVELS = {
	empty_case: "error",
	/** Given before, ignoring case. */
	repeated_value: "error",
	/** Choice value unavailable. */
	vanished: "warning",
	/** Condition field undeclared. */
	unknown_field: "inactive",
	/** Unsupported condition operator. */
	untaken_operator: "inactive",
	too_long: "error",
	too_many: "error",
	trigger: "inactive",
	/** Placeholders cannot be read. */
	unready: "inactive",
	/** Name shadows entity. */
	shadows: "warning",
	unfit: "error",
	/** Function absent from carry. */
	left: "inactive",
	unread: "inactive",
	unparsed: "error",
} as const satisfies Record<string, AutomationIssueLevel>;

/** Fixed-level issue. */
export type IssueCause = keyof typeof CAUSE_LEVELS;
export const ISSUE_LEVELS: Readonly<Record<IssueCause, AutomationIssueLevel>> = CAUSE_LEVELS;

export const AUTOMATION_ISSUES_MAX = 256;

export const AutomationIssueSchema = z
	.object({
		level: z.enum(AUTOMATION_ISSUE_LEVELS),
		record: z.enum(SAVE_RECORDS),
		/** Function id. */
		id: z.string().optional(),
		/** Record-relative path. */
		step: z.string().regex(STEP_PATH_RE).max(64).optional(),
		param: z.string().max(32).optional(),
		start: z.number().int().nonnegative().optional(),
		end: z.number().int().nonnegative().optional(),
		/** A switch case's number. */
		case: z.number().int().nonnegative().optional(),
		/** A case's value. */
		value: z.string().max(SAVE_LINE_MAX).optional(),
		/** Display text; never evaluated. */
		line: z.string().max(SAVE_LINE_MAX),
	})
	.meta({ id: "AutomationIssue" });
export type AutomationIssue = z.infer<typeof AutomationIssueSchema>;

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

export const AutomationSaveCalledSchema = z
	.strictObject({
		id: z.string().regex(RULE_ID_RE),
		body: FunctionSchema,
		base: z.number().int().nonnegative(),
	})
	.meta({ id: "AutomationSaveCalled" });

export const AutomationSaveOpShape = {
	kind: z.literal("automation_save"),
	automationId: z.string().regex(RULE_ID_RE),
	automation: AutomationSchema,
	/** 0 adds. */
	automationBase: z.number().int().nonnegative(),
	/** Absent: flat or unchanged. */
	function: AutomationSaveFunctionSchema.optional(),
	/** Functions it runs, written with it; base 0 adds. */
	called: z.array(AutomationSaveCalledSchema).max(FUNCTIONS_MAX).optional(),
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
		/** Proposed save issues. */
		issues: z.array(AutomationIssueSchema).max(AUTOMATION_ISSUES_MAX).optional(),
	})
	.meta({ id: "ConsoleAutomationCheckResult" });
export type ConsoleAutomationCheckResult = z.infer<typeof ConsoleAutomationCheckResultSchema>;

export const ConsoleAutomationSaveResultSchema = z
	.object({
		stored: z.boolean(),
		automation: AutomationRowSchema.optional(),
		function: AutomationFunctionRowSchema.optional(),
		/** The called functions it wrote. */
		called: z.array(AutomationFunctionRowSchema).max(FUNCTIONS_MAX).optional(),
		refusal: AutomationSaveRefusalSchema.optional(),
		/** Saved issues. */
		issues: z.array(AutomationIssueSchema).max(AUTOMATION_ISSUES_MAX).optional(),
	})
	.meta({ id: "ConsoleAutomationSaveResult" });
export type ConsoleAutomationSaveResult = z.infer<typeof ConsoleAutomationSaveResultSchema>;
