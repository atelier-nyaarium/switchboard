import { z } from "zod";
import { STEP_PATH_RE } from "./automation-walk.js";
import { RULE_ID_RE } from "./schemasAssistantRules.js";
import { AutomationTriggerSchema } from "./schemasAutomation.js";
import {
	FUNCTION_NAME_MAX,
	FUNCTION_PARAMS_MAX,
	FUNCTION_STEPS_MAX,
	FUNCTION_STEPS_TOTAL_MAX,
	FUNCTIONS_MAX,
	FunctionParamSchema,
	FunctionStepSchema,
	PARAM_NAME_MAX,
	STEP_TEXT_MAX,
} from "./schemasFunction.js";
import { SCRIPT_SOURCE_MAX } from "./script-grammar.js";
import { SCRIPT_TYPE_MAX } from "./script-types.js";

export const SCRIPT_TEXT_SCHEMA = z.string().max(SCRIPT_SOURCE_MAX);
export const SCRIPT_ISSUES_MAX = 8;
export const SCRIPT_ISSUE_MAX = 200;
/** Names per script. */
export const SCRIPT_NAMES_MAX = 64;
export const SCRIPT_TYPES_MAX = 4;
export const SCRIPT_TYPE_MEMBERS_MAX = 64;

export const ScriptFunctionSchema = z
	.object({
		id: z.string().regex(RULE_ID_RE),
		name: z.string().max(FUNCTION_NAME_MAX),
		params: z.array(FunctionParamSchema).max(FUNCTION_PARAMS_MAX),
	})
	.meta({ id: "ScriptFunction" });
export type ScriptFunction = z.infer<typeof ScriptFunctionSchema>;

export const SCRIPT_CONTEXT = {
	trigger: AutomationTriggerSchema.optional(),
	params: z.array(FunctionParamSchema).max(FUNCTION_PARAMS_MAX).optional(),
	/** The draft's functions, over the stored ones. */
	functions: z.array(ScriptFunctionSchema).max(FUNCTIONS_MAX).optional(),
};

/** UTF-16 offsets into the text. */
const SPAN = { start: z.number().int().nonnegative(), end: z.number().int().nonnegative() };

export const ScriptNameSchema = z
	.object({ name: z.string().max(PARAM_NAME_MAX), type: z.string().max(SCRIPT_TYPE_MAX), ...SPAN })
	.meta({ id: "ScriptName" });
export type ScriptName = z.infer<typeof ScriptNameSchema>;

export const ScriptStatementSchema = z
	.object({ step: z.string().regex(STEP_PATH_RE).max(64), ...SPAN })
	.meta({ id: "ScriptStatement" });

export const ScriptTypeSchema = z
	.object({
		name: z.string().max(SCRIPT_TYPE_MAX),
		members: z
			.array(
				z
					.object({ name: z.string().max(64), type: z.string().max(SCRIPT_TYPE_MAX) })
					.meta({ id: "ScriptTypeMember" }),
			)
			.max(SCRIPT_TYPE_MEMBERS_MAX),
	})
	.meta({ id: "ScriptType" });

export const ScriptIssueSchema = z
	.object({ ...SPAN, message: z.string().max(SCRIPT_ISSUE_MAX) })
	.meta({ id: "ScriptIssue" });

export const ConsoleScriptPrintResultSchema = z
	.object({
		/** Empty when too long to show. */
		text: SCRIPT_TEXT_SCHEMA,
		readOnly: z.string().max(SCRIPT_ISSUE_MAX).optional(),
		names: z.array(ScriptNameSchema).max(SCRIPT_NAMES_MAX),
		/** `Error`, and `Event` under an event trigger. */
		types: z.array(ScriptTypeSchema).max(SCRIPT_TYPES_MAX),
		statements: z.array(ScriptStatementSchema).max(FUNCTION_STEPS_TOTAL_MAX),
	})
	.meta({ id: "ConsoleScriptPrintResult" });
export type ConsoleScriptPrintResult = z.infer<typeof ConsoleScriptPrintResultSchema>;

export const ConsoleScriptParseResultSchema = z
	.object({
		/** Canonical; absent when the text does not parse. */
		steps: z.array(FunctionStepSchema).max(FUNCTION_STEPS_MAX).optional(),
		/** Why it does not parse, or what a save would refuse of its steps. */
		issues: z.array(ScriptIssueSchema).max(SCRIPT_ISSUES_MAX).optional(),
		/** Read past an issue too. */
		names: z.array(ScriptNameSchema).max(SCRIPT_NAMES_MAX),
		/** `Error`, and `Event` under an event trigger. */
		types: z.array(ScriptTypeSchema).max(SCRIPT_TYPES_MAX),
		statements: z.array(ScriptStatementSchema).max(FUNCTION_STEPS_TOTAL_MAX),
		placed: z.object(SPAN).meta({ id: "ScriptSpan" }).optional(),
	})
	.meta({ id: "ConsoleScriptParseResult" });
export type ConsoleScriptParseResult = z.infer<typeof ConsoleScriptParseResultSchema>;

export const ScriptPlaceRequestSchema = z
	.object({
		step: z.string().regex(STEP_PATH_RE).max(64),
		param: z.string().max(PARAM_NAME_MAX).optional(),
		start: z.number().int().nonnegative().max(STEP_TEXT_MAX).optional(),
		end: z.number().int().nonnegative().max(STEP_TEXT_MAX).optional(),
	})
	.meta({ id: "ScriptPlaceRequest" });
