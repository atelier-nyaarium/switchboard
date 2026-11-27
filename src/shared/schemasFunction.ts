// A function: a named body an automation points at.

import { z } from "zod";
import { type HeldSide, sidesOf, walked } from "./automation-walk.js";
import { RULE_ID_RE } from "./schemasAssistantRules.js";
import { ASSISTANT_RULE_VALUE_MAX } from "./wire-vocabulary.js";

/** Store-wide total. */
export const FUNCTIONS_MAX = 256;
/** In one list. */
export const FUNCTION_STEPS_MAX = 256;
/** Across every depth. */
export const FUNCTION_STEPS_TOTAL_MAX = 256;
export const FUNCTION_DEPTH_MAX = 256;
/** A day. */
export const WAIT_MINUTES_MAX = 1_440;
export const FUNCTION_PARAMS_MAX = 256;
/** Maximum concurrent steps. */
export const RUN_STRANDS_MAX = 256;
/** Run variables. */
export const FRAME_VARS_MAX = 16;
/** A run's variables, and `e`. */
export const RUN_NAMES_MAX = FRAME_VARS_MAX + 1;
export const FUNCTION_NAME_MAX = 80;
export const STEP_TEXT_MAX = 1_000;
/** Step argument values. */
export const STEP_ARGS_MAX = 256;
/** A script's whole text. */
export const SCRIPT_SOURCE_MAX = 24_000;
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
		/** As written; an action's text parameter alone fills its holes. */
		z.strictObject({ kind: z.literal("literal"), value: LiteralValueSchema }),
		/** Blank hole text fails. */
		z.strictObject({ kind: z.literal("expression"), text: z.string().max(STEP_TEXT_MAX) }),
	])
	.meta({ id: "StepArg" });
export type StepArg = z.infer<typeof StepArgSchema>;

/** A list a step holds. */
const side = () => z.array(FunctionStepSchema).max(FUNCTION_STEPS_MAX);

/** Walk-entry limit. */
export const SWITCH_CASES_MAX = 256;
/** Walk-entry limit. */
export const SWITCH_CASE_VALUES_MAX = 256;

/** Empty cases error. */
export const SwitchCaseSchema = z
	.strictObject({
		values: z.array(z.string().max(ASSISTANT_RULE_VALUE_MAX)).max(SWITCH_CASE_VALUES_MAX),
		get steps() {
			return side();
		},
	})
	.meta({ id: "SwitchCase" });

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
		z.strictObject({
			kind: z.literal("if"),
			/** Blank expressions fail. */
			when: z.string().max(STEP_TEXT_MAX),
			/** The side taken when it holds. */
			get steps() {
				return side().optional();
			},
			get else() {
				return side().optional();
			},
		}),
		/** First match, else default. */
		z.strictObject({
			kind: z.literal("switch"),
			/** Blank expressions fail. */
			subject: z.string().max(STEP_TEXT_MAX),
			get cases() {
				return z.array(SwitchCaseSchema).max(SWITCH_CASES_MAX);
			},
			get default() {
				return side().optional();
			},
		}),
		z.strictObject({
			kind: z.literal("try"),
			/** The guarded side. */
			get steps() {
				return side();
			},
			get catch() {
				return side();
			},
		}),
		/** Concurrent branches join. */
		z.strictObject({
			kind: z.literal("parallel"),
			get steps() {
				return side();
			},
		}),
		/** Task kept under `as`. */
		z.strictObject({
			kind: z.literal("start"),
			as: z.string().regex(PARAM_NAME_RE).optional(),
			get steps() {
				return side();
			},
		}),
		z.strictObject({
			kind: z.literal("await"),
			task: z.string().min(1).max(STEP_TEXT_MAX),
			as: z.string().regex(PARAM_NAME_RE).optional(),
		}),
		z.strictObject({ kind: z.literal("exit") }),
		z.strictObject({ kind: z.literal("throw"), text: z.string().max(STEP_TEXT_MAX).optional() }),
		z.strictObject({ kind: z.literal("let"), name: z.string().regex(PARAM_NAME_RE), value: StepArgSchema }),
		z.strictObject({ kind: z.literal("wait"), minutes: StepArgSchema }),
		z.strictObject({ kind: z.literal("note"), text: z.string().max(STEP_TEXT_MAX) }),
		/** Unparsed scripts stand alone. */
		z.strictObject({ kind: z.literal("unparsed"), source: z.string().max(SCRIPT_SOURCE_MAX) }),
		/** Runs another function and waits for it. */
		z.strictObject({
			kind: z.literal("call"),
			function: z.string().regex(RULE_ID_RE),
			/** By the callee's value names; read when the call starts. */
			values: z
				.record(z.string().regex(PARAM_NAME_RE), StepArgSchema)
				.refine((values) => Object.keys(values).length <= FUNCTION_PARAMS_MAX, { message: "too many values" })
				.optional(),
		}),
	])
	.meta({ id: "FunctionStep" });
export type FunctionStep = z.infer<typeof FunctionStepSchema>;

/** No name: one automation's own steps. */
export const unnamed = (fn: { name: string }): boolean => fn.name === "";

/** Keyed by every kind. */
const STATEMENTS: { [K in FunctionStep["kind"]]: true } = {
	do: true,
	if: true,
	switch: true,
	try: true,
	parallel: true,
	start: true,
	await: true,
	exit: true,
	throw: true,
	let: true,
	wait: true,
	note: true,
	unparsed: true,
	call: true,
};
/** Every kind a step may be. */
export const FUNCTION_STATEMENT_KINDS = Object.keys(STATEMENTS) as FunctionStep["kind"][];

/** Every step at every depth. */
const countOf = (steps: readonly FunctionStep[]): number =>
	steps.reduce((sum, step) => sum + 1 + sidesOf(step).reduce((held, side) => held + countOf(side.steps), 0), 0);

/** Else-if chain link. */
const chained = (step: FunctionStep, side: HeldSide<FunctionStep>): boolean =>
	step.kind === "if" && side.side === "else" && side.steps.length === 1 && side.steps[0]?.kind === "if";

/** Else-if adds no depth. */
const depthOf = (steps: readonly FunctionStep[]): number =>
	steps.reduce(
		(deepest, step) =>
			Math.max(deepest, 1, ...sidesOf(step).map((side) => (chained(step, side) ? 0 : 1) + depthOf(side.steps))),
		steps.length > 0 ? 1 : 0,
	);

/** A body's steps within its bounds; may be empty. */
export const FunctionStepsSchema = z
	.array(FunctionStepSchema)
	.max(FUNCTION_STEPS_MAX)
	.refine((steps) => countOf(steps) <= FUNCTION_STEPS_TOTAL_MAX, { message: "too many steps" })
	.refine((steps) => depthOf(steps) <= FUNCTION_DEPTH_MAX, { message: "steps nest too deep" });

export const FunctionSchema = z
	.strictObject({
		/** Empty: one automation's own steps. */
		name: z
			.string()
			.max(FUNCTION_NAME_MAX)
			.refine((name) => name === "" || name.trim() !== "", { message: "a name of spaces" }),
		params: z.array(FunctionParamSchema).max(FUNCTION_PARAMS_MAX),
		steps: walked(FunctionStepsSchema.min(1)),
	})
	.refine((fn) => new Set(fn.params.map((param) => param.name)).size === fn.params.length, {
		message: "a value is named twice",
		path: ["params"],
	})
	.meta({ id: "AutomationFunction" });

/** Open `steps` only through the walk. */
export type AutomationFunction = z.output<typeof FunctionSchema>;
export type AutomationFunctionInput = z.input<typeof FunctionSchema>;
