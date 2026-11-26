// What makes an automation invalid or unarmed on this Gateway.

import { fitOf, functionReads, type TriggerGiven, triggerGiven } from "../../shared/automation-fit.js";
import {
	type FunctionOf,
	type LeafAction,
	pointerOf,
	reached,
	type Unfollowed,
	visit,
	type WalkEntry,
	written,
} from "../../shared/automation-walk.js";
import {
	AUTOMATION_ACTIONS,
	AUTOMATION_TRIGGER_NAMES,
	type Automation,
	type AutomationActionParam,
	AutomationActionSchema,
	type AutomationTrigger,
	FUNCTION_STEP_KINDS,
} from "../../shared/schemasAutomation.js";
import type { AutomationFunction, FunctionStep, StepArg } from "../../shared/schemasFunction.js";
import { hasHoles } from "../../shared/text-holes.js";
import type { OwnerIssue, OwnerRecord } from "../ownerRecords.js";
import { clockIssue, isClock } from "./automationClock.js";
import type { EffectKind } from "./automationRunner.js";
import { holeNames } from "./automationScope.js";
import type { AutomationsDeps } from "./automations.js";
import { holeOwnerIssue } from "./automationText.js";
import { crossingField } from "./crossingBand.js";

export type ValidityDeps = Pick<
	AutomationsDeps,
	"fields" | "reading" | "eventIssue" | "eventFields" | "holes" | "actions"
>;

type StepKind = (typeof FUNCTION_STEP_KINDS)[number];

const STEP_ACTIONS: Readonly<Record<EffectKind | "tell_assistant", true>> = Object.fromEntries(
	FUNCTION_STEP_KINDS.map((kind) => [kind, true]),
) as Record<StepKind, true>;
const stepAction = (kind: string): kind is StepKind => Object.hasOwn(STEP_ACTIONS, kind);

/** Fit checks which. */
const TRIGGER_NAMES = [...new Set(Object.values(AUTOMATION_TRIGGER_NAMES).flat())];

export const FUNCTION_GONE = "the function it runs is gone";
export const FUNCTION_LEFT = "its function did not come with the move";
export const FUNCTION_UNREAD = "the function it runs was written by a newer build; update this Gateway";
export const FUNCTION_UNFIT = "it does not fit the function it runs";
export const NO_SWITCH = "no such switch on this Gateway";
/** A step's values fail its action. */
export const STEP_UNFIT = "its values do not fit what it does";
export const STEP_ISSUE_CODE = "invalid_step";
const NO_ACTION = "this Gateway runs no such action";
const UNRUNNABLE = "a step does what this Gateway cannot run";

/** Spans as written. */
export interface StepIssue {
	param?: string;
	start?: number;
	end?: number;
	message: string;
	/** Unrunnable step action. */
	unrunnable?: true;
}

/** Why a call cannot run its function. */
export type CallIssue = { kind: "unfit" } | { kind: "switch"; param: string };

export type BodyIssue =
	| { at: "trigger"; message: string }
	| { at: "action"; index: number; issue: StepIssue }
	| { at: "step"; via: string; index: number; issue: StepIssue }
	/** Unfollowed function call. */
	| { at: "call"; function: string; message: string }
	| { at: "fit"; function: string; issue: CallIssue };

export type StepBodyIssue = Extract<BodyIssue, { at: "step" }>;
export type FitBodyIssue = Extract<BodyIssue, { at: "fit" }>;

export const isStepIssue = (issue: BodyIssue): issue is StepBodyIssue => issue.at === "step";
export const isFitIssue = (issue: BodyIssue): issue is FitBodyIssue => issue.at === "fit";

const LINES: { [A in BodyIssue["at"]]: (issue: Extract<BodyIssue, { at: A }>) => string } = {
	trigger: (issue) => issue.message,
	action: ({ issue }) => issue.message,
	step: ({ issue }) => issue.message,
	call: (issue) => issue.message,
	fit: ({ issue }) => (issue.kind === "unfit" ? FUNCTION_UNFIT : NO_SWITCH),
};

export const lineOf = (issue: BodyIssue): string => (LINES[issue.at] as (held: BodyIssue) => string)(issue);

/** Flat action arguments. */
const literalArgs = (action: Record<string, unknown>): Record<string, StepArg> =>
	Object.fromEntries(
		Object.entries(action).flatMap(([name, value]): [string, StepArg][] =>
			name === "kind" || value === undefined ? [] : [[name, { kind: "literal", value } as StepArg]],
		),
	);

/** `unread`: a function row held but not readable here. */
export function createAutomationValidity(
	deps: ValidityDeps,
	functionOf: FunctionOf,
	unread: (id: string) => boolean = () => false,
) {
	function triggerIssue(body: Pick<Automation, "trigger">): string | null {
		if (body.trigger.kind === "event") {
			return deps.eventIssue ? deps.eventIssue(body.trigger) : "this Gateway holds no sources";
		}
		if (body.trigger.kind === "crossing") {
			const { device, measure } = body.trigger;
			if (!deps.reading?.(device, measure)) return "no such number on this Gateway";
			return deps.fields.check(crossingField(body.trigger));
		}
		if (isClock(body.trigger)) return clockIssue(body.trigger);
		const { field, becomes } = body.trigger;
		const type = deps.fields.typeOf(field);
		if (!type) return deps.fields.invalidOf(field) ?? "no such field";
		if (type.type === "boolean") return typeof becomes === "boolean" ? null : "this field is true or false";
		if (type.type === "choice") {
			return typeof becomes === "string" && type.members.includes(becomes)
				? null
				: `${String(becomes)} is not one of its values`;
		}
		return "only a field of choices or true and false can trigger";
	}

	/** What a trigger gives a function, typed. */
	const givenOf = (trigger: AutomationTrigger): TriggerGiven => {
		if (trigger.kind === "value") {
			const type = deps.fields.typeOf(trigger.field)?.type;
			return triggerGiven("value", { fieldType: type === "number" ? "number" : "text" });
		}
		if (trigger.kind === "event")
			return triggerGiven("event", { eventFields: deps.eventFields?.(trigger.source) ?? [] });
		return triggerGiven(trigger.kind);
	};

	const switchHeld = (device: unknown): boolean =>
		typeof device === "string" && (deps.actions?.switchName(device) ?? null) !== null;

	/** A hole's issue in a text; `shift` for an expression's braces. */
	const holeIn = (text: string, names: readonly string[], shift: number): Omit<StepIssue, "param"> | null => {
		const holes = deps.holes?.();
		const issue = holes
			? holes.issue(text, names)
			: { start: 0, end: text.length, message: "holes cannot be read yet" };
		if (!issue) return null;
		const length = text.length - 2 * shift;
		const clamp = (offset: number) => Math.min(length, Math.max(0, offset - shift));
		return { start: clamp(issue.start), end: clamp(issue.end), message: issue.message };
	};

	/** Null names skip holes. */
	function argsIssue(
		kind: string,
		args: Readonly<Record<string, StepArg>>,
		names: readonly string[] | null,
	): StepIssue | null {
		if (!stepAction(kind)) return { message: UNRUNNABLE, unrunnable: true };
		if (kind !== "tell_assistant" && !deps.actions) return { message: NO_ACTION };
		const params: readonly AutomationActionParam[] = AUTOMATION_ACTIONS[kind].params;
		for (const name of Object.keys(args)) {
			if (!params.some((param) => param.name === name)) return { param: name, message: `it takes no ${name}` };
		}
		for (const param of params) {
			if (!param.optional && !Object.hasOwn(args, param.name))
				return { param: param.name, message: `${param.label} is missing` };
		}
		const literal: Record<string, unknown> = { kind };
		let literalOnly = true;
		for (const param of params) {
			const arg = Object.hasOwn(args, param.name) ? args[param.name] : undefined;
			if (!arg) continue;
			if (arg.kind === "expression") {
				literalOnly = false;
				const issue = holeIn(`{${arg.text}}`, names ?? [], 1);
				if (issue) return { param: param.name, ...issue };
				continue;
			}
			const { value } = arg;
			literal[param.name] = value;
			if (names !== null && typeof value === "string" && hasHoles(value)) {
				if (param.kind !== "text")
					return { param: param.name, start: 0, end: value.length, message: "only a text takes a hole" };
				const issue = holeIn(value, names, 0);
				if (issue) return { param: param.name, ...issue };
				continue;
			}
			if (param.kind === "switch" && !switchHeld(value)) return { param: param.name, message: NO_SWITCH };
			if (param.kind === "choice" && !(param.options ?? []).some((option) => option.value === value))
				return { param: param.name, message: `${String(value)} is not one of its values` };
		}
		if (literalOnly && !AutomationActionSchema.safeParse(literal).success) return { message: STEP_UNFIT };
		return null;
	}

	const STEPS: {
		[K in FunctionStep["kind"]]: (
			fn: Pick<AutomationFunction, "params">,
			step: Extract<FunctionStep, { kind: K }>,
		) => StepIssue | null;
	} = {
		do: (fn, step) => {
			if (!stepAction(step.action)) return { message: UNRUNNABLE, unrunnable: true };
			if (step.as !== undefined) return { message: "a step cannot keep its result yet" };
			return argsIssue(step.action, step.args, holeNames(TRIGGER_NAMES, fn.params));
		},
	};

	const stepIssue = (fn: Pick<AutomationFunction, "params">, step: FunctionStep): StepIssue | null =>
		STEPS[step.kind](fn, step);

	/** Fit, then each device value against the switches. */
	function callIssue(body: Automation, fn: AutomationFunction): CallIssue | null {
		const call = pointerOf(body);
		if (!call) return null;
		const given = givenOf(body.trigger);
		const values = call.values ?? {};
		if (!fitOf(given, { params: fn.params, reads: functionReads(fn) }, values).fits) return { kind: "unfit" };
		const fromTrigger = new Set(given.names.map((held) => held.name));
		for (const param of fn.params) {
			if (param.type !== "device" || fromTrigger.has(param.name) || !Object.hasOwn(values, param.name)) continue;
			if (!switchHeld(values[param.name])) return { kind: "switch", param: param.name };
		}
		return null;
	}

	/** Null lookup, flat walk. */
	function* assessBody(body: Automation, functions: FunctionOf | null = functionOf): Generator<BodyIssue> {
		const trigger = triggerIssue(body);
		if (trigger !== null) yield { at: "trigger", message: trigger };
		const names = AUTOMATION_TRIGGER_NAMES[body.trigger.kind];
		const unfollowed: Record<Unfollowed, (id: string) => string | null> = {
			"not-expanded": () => null,
			// Moves strip event users.
			missing: (id) =>
				unread(id) ? FUNCTION_UNREAD : body.trigger.kind === "event" ? FUNCTION_LEFT : FUNCTION_GONE,
		};
		for (const at of functions ? reached(body, functions) : reached(body)) {
			const found = visit<WalkEntry, BodyIssue | null>(at, {
				action: ({ index, action }) => {
					const issue = argsIssue(action.kind, literalArgs(action), names);
					return issue && { at: "action", index, issue };
				},
				step: {
					do: ({ index, step, via }) => {
						const fn = functions?.(via);
						const issue = fn ? stepIssue(fn, step) : null;
						return issue && { at: "step", via, index, issue };
					},
				},
				unfollowedCall: ({ call, reason }) => {
					const message = unfollowed[reason](call.function);
					return message === null ? null : { at: "call", function: call.function, message };
				},
			});
			if (found) yield found;
		}
		const call = functions ? pointerOf(body) : null;
		const fn = call ? functions?.(call.function) : null;
		const unfit = call && fn ? callIssue(body, fn) : null;
		if (call && unfit) yield { at: "fit", function: call.function, issue: unfit };
	}

	const first = (
		issues: Iterable<BodyIssue>,
		stops: (issue: BodyIssue) => boolean = () => true,
	): BodyIssue | null => {
		for (const issue of issues) if (stops(issue)) return issue;
		return null;
	};

	/** Why this Gateway cannot run it; read every time. */
	const automationIssue = (body: Automation, functions: FunctionOf | null = functionOf): string | null => {
		const issue = first(assessBody(body, functions));
		return issue && lineOf(issue);
	};

	/** Fit and step detail: the judge's and the function row's. */
	const stopsWrite = (issue: BodyIssue): boolean =>
		issue.at !== "fit" && (issue.at !== "step" || issue.issue.unrunnable === true);

	const holed = (issue: StepIssue): issue is StepIssue & { param: string; start: number; end: number } =>
		issue.start !== undefined && issue.end !== undefined && issue.param !== undefined;

	/** Return hole spans first. */
	function writeIssue(body: Automation, functions: FunctionOf): OwnerIssue | string | null {
		const issues = [...assessBody(body, functions)].filter(stopsWrite);
		for (const held of issues) {
			if (held.at === "action" && holed(held.issue)) {
				return holeOwnerIssue({ action: held.index, param: held.issue.param }, held.issue);
			}
		}
		const [issue] = issues;
		return issue ? lineOf(issue) : null;
	}

	/** First function-step issue. */
	function functionIssue(fn: AutomationFunction): OwnerIssue | null {
		for (const [index, step] of written(fn).entries()) {
			const issue = stepIssue(fn, step);
			if (!issue) continue;
			if (holed(issue)) return holeOwnerIssue({ action: index, param: issue.param }, issue, "steps");
			return {
				path: ["steps", index, ...(issue.param ? [issue.param] : [])],
				message: issue.message,
				code: STEP_ISSUE_CODE,
			};
		}
		return null;
	}

	/** Steps precede fit checks. */
	const entryIssue = (body: Automation, id: string, fn: AutomationFunction): string | null => {
		const issue = first(
			assessBody(body, (held) => (held === id ? fn : null)),
			(held) => held.at === "step" || held.at === "fit",
		);
		return issue && lineOf(issue);
	};

	/** Validate resolved step values. */
	function resolved(
		kind: string,
		values: Readonly<Record<string, unknown>>,
	): { action: LeafAction } | { refused: string } {
		const parsed = AutomationActionSchema.safeParse({ ...values, kind });
		if (!parsed.success || parsed.data.kind === "run_function") return { refused: STEP_UNFIT };
		const issue = argsIssue(kind, literalArgs(parsed.data), null);
		return issue ? { refused: issue.message } : { action: parsed.data };
	}

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

	return {
		triggerIssue,
		givenOf,
		assessBody,
		automationIssue,
		writeIssue,
		functionIssue,
		entryIssue,
		resolved,
		armed,
	};
}
