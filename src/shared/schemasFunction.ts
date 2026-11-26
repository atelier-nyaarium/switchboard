// A function: a named body an automation points at.

import { z } from "zod";
import { walked } from "./automation-walk.js";

/** Store-wide total. */
export const FUNCTIONS_MAX = 32;
export const FUNCTION_STEPS_MAX = 8;
export const FUNCTION_PARAMS_MAX = 8;
export const FUNCTION_NAME_MAX = 80;
export const STEP_TEXT_MAX = 1_000;
/** The widest action row's parameters. */
export const STEP_ARGS_MAX = 4;
export const FUNCTION_PARAM_TYPES = ["device", "text", "number"] as const;
export type FunctionParamType = (typeof FUNCTION_PARAM_TYPES)[number];

export const PARAM_NAME_MAX = 32;
export const PARAM_NAME_RE = new RegExp(`^[a-z][a-z0-9_]{0,${PARAM_NAME_MAX - 1}}$`);

export const FunctionParamSchema = z
	.strictObject({ name: z.string().regex(PARAM_NAME_RE), type: z.enum(FUNCTION_PARAM_TYPES) })
	.meta({ id: "FunctionParam" });
export type FunctionParam = z.infer<typeof FunctionParamSchema>;

export const LiteralValueSchema = z.union([z.string().max(STEP_TEXT_MAX), z.number().finite(), z.boolean()]);

/** Read at step start. */
export const StepArgSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("literal"), value: LiteralValueSchema }),
		z.strictObject({ kind: z.literal("expression"), text: z.string().min(1).max(STEP_TEXT_MAX) }),
	])
	.meta({ id: "StepArg" });
export type StepArg = z.infer<typeof StepArgSchema>;

export const FunctionStepSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("do"),
			action: z.string().min(1).max(32),
			as: z.string().regex(PARAM_NAME_RE).optional(),
			args: z
				.record(z.string().max(32), StepArgSchema)
				.refine((args) => Object.keys(args).length <= STEP_ARGS_MAX, { message: "too many values" }),
		}),
	])
	.meta({ id: "FunctionStep" });
export type FunctionStep = z.infer<typeof FunctionStepSchema>;

export const FunctionSchema = z
	.strictObject({
		name: z.string().min(1).max(FUNCTION_NAME_MAX),
		params: z.array(FunctionParamSchema).max(FUNCTION_PARAMS_MAX),
		steps: walked(z.array(FunctionStepSchema).min(1).max(FUNCTION_STEPS_MAX)),
	})
	.refine((fn) => new Set(fn.params.map((param) => param.name)).size === fn.params.length, {
		message: "a value is named twice",
		path: ["params"],
	})
	.meta({ id: "AutomationFunction" });

/** Open `steps` only through the walk. */
export type AutomationFunction = z.output<typeof FunctionSchema>;
export type AutomationFunctionInput = z.input<typeof FunctionSchema>;
