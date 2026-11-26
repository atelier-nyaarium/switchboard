// A function: a named body an automation points at.

import { z } from "zod";
import { walked } from "./automation-walk.js";
import { RULE_ID_RE } from "./schemasAssistantRules.js";

/** Store-wide total. */
export const FUNCTIONS_MAX = 32;
/** In one list. */
export const FUNCTION_STEPS_MAX = 8;
/** Across every depth. */
export const FUNCTION_STEPS_TOTAL_MAX = 32;
export const FUNCTION_DEPTH_MAX = 4;
/** A day. */
export const WAIT_MINUTES_MAX = 1_440;
export const FUNCTION_PARAMS_MAX = 8;
/** Maximum concurrent steps. */
export const RUN_STRANDS_MAX = 8;
/** A run's variables, and `e`. */
export const RUN_NAMES_MAX = 17;
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
		/** As written; an action's text parameter alone fills its holes. */
		z.strictObject({ kind: z.literal("literal"), value: LiteralValueSchema }),
		z.strictObject({ kind: z.literal("expression"), text: z.string().min(1).max(STEP_TEXT_MAX) }),
		/** Its holes fill at the step's turn. */
		z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(STEP_TEXT_MAX) }),
	])
	.meta({ id: "StepArg" });
export type StepArg = z.infer<typeof StepArgSchema>;

/** A list a step holds. */
const side = () => z.array(FunctionStepSchema).max(FUNCTION_STEPS_MAX);

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
			/** One expression. */
			when: z.string().min(1).max(STEP_TEXT_MAX),
			/** The side taken when it holds. */
			get steps() {
				return side().optional();
			},
			get else() {
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
		z.strictObject({ kind: z.literal("exit") }),
		z.strictObject({ kind: z.literal("throw"), text: z.string().max(STEP_TEXT_MAX).optional() }),
		z.strictObject({ kind: z.literal("let"), name: z.string().regex(PARAM_NAME_RE), value: StepArgSchema }),
		z.strictObject({ kind: z.literal("wait"), minutes: StepArgSchema }),
		z.strictObject({ kind: z.literal("note"), text: z.string().max(STEP_TEXT_MAX) }),
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
	try: true,
	parallel: true,
	exit: true,
	throw: true,
	let: true,
	wait: true,
	note: true,
	call: true,
};
/** Every kind a step may be. */
export const FUNCTION_STATEMENT_KINDS = Object.keys(STATEMENTS) as FunctionStep["kind"][];

type Tree = { kind: string; steps?: readonly Tree[]; else?: readonly Tree[]; catch?: readonly Tree[] };

/** Every step at every depth. */
const countOf = (steps: readonly Tree[]): number =>
	steps.reduce(
		(sum, step) => sum + 1 + countOf(step.steps ?? []) + countOf(step.else ?? []) + countOf(step.catch ?? []),
		0,
	);

/** A flat list is one deep. */
const depthOf = (steps: readonly Tree[]): number =>
	steps.reduce(
		(deepest, step) =>
			Math.max(
				deepest,
				1 + depthOf(step.steps ?? []),
				1 + depthOf(step.else ?? []),
				1 + depthOf(step.catch ?? []),
			),
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
