// What makes an automation invalid or unarmed on this Gateway.

import { fitOf, functionReads, type TriggerGiven, triggerGiven } from "../../shared/automation-fit.js";
import {
	type Address,
	type FunctionOf,
	functionWidth,
	type LeafAction,
	pointerOf,
	type RunFunction,
	reached,
	steering,
	stepsOf,
	type Unfollowed,
	visit,
	type WalkEntry,
	widthOf,
} from "../../shared/automation-walk.js";
import { CONSOLE_WORD_OPS, parseConsoleExpression } from "../../shared/live-console-grammar.js";
import {
	AUTOMATION_ACTIONS,
	AUTOMATION_TRIGGER_NAMES,
	type Automation,
	type AutomationActionParam,
	type AutomationActionRow,
	AutomationActionSchema,
	type AutomationTrigger,
	FUNCTION_STEP_KINDS,
	type FunctionValue,
} from "../../shared/schemasAutomation.js";
import {
	type AutomationFunction,
	type FunctionStep,
	RUN_STRANDS_MAX,
	type StepArg,
	unnamed,
	WAIT_MINUTES_MAX,
} from "../../shared/schemasFunction.js";
import { SCRIPT_RESERVED } from "../../shared/script-grammar.js";
import { hasHoles } from "../../shared/text-holes.js";
import type { OwnerIssue, OwnerRecord } from "../ownerRecords.js";
import { clockIssue, isClock } from "./automationClock.js";
import { ownerOf } from "./automationFrames.js";
import type { EffectKind } from "./automationRunner.js";
import { holeNames } from "./automationScope.js";
import type { AutomationsDeps } from "./automations.js";
import { holeOwnerIssue, nameOwnerIssue, stepOwnerIssue } from "./automationText.js";
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
export const CALL_LOOPS = "a function it runs calls itself";
export const FUNCTION_PRIVATE = "it runs steps that belong to one automation";
export const CALLS_TOO_MUCH = "it runs more than one run may";
export const FUNCTION_UNREAD = "the function it runs was written by a newer build; update this Gateway";
export const FUNCTION_UNFIT = "it does not fit the function it runs";
export const NO_SWITCH = "no such switch on this Gateway";
/** A step's values fail its action. */
export const STEP_UNFIT = "its values do not fit what it does";

const writesText = (source: string): boolean => {
	const { node } = parseConsoleExpression(source);
	return node?.kind === "template" || (node?.kind === "literal" && typeof node.value === "string");
};
const NO_ACTION = "this Gateway runs no such action";
const UNRUNNABLE = "a step does what this Gateway cannot run";
export const NAME_TAKEN = "that name is already a value here";
export const NAME_RESERVED = "that name is reserved";
export const EXIT_BESIDE = "an exit here would leave the steps beside it running";
export const TOO_WIDE = `more than ${RUN_STRANDS_MAX} steps would run at once`;
export const UNPARSED_ALONE = "a script with errors stands alone in its function";

/** Words the language keeps. */
const RESERVED_NAMES = new Set<string>([...SCRIPT_RESERVED, ...CONSOLE_WORD_OPS, "true", "false", "null"]);
export const GIVES_NOTHING = "this action gives nothing to keep";

type Giving = {
	[K in keyof typeof AUTOMATION_ACTIONS]: (typeof AUTOMATION_ACTIONS)[K] extends { gives: unknown } ? K : never;
}[keyof typeof AUTOMATION_ACTIONS];
/** The first action that gives stops the build here: a step's end must then store its result. */
const STORES_RESULTS: [Giving] extends [never] ? false : never = false;
export const WAIT_RANGE = "a wait is between 0 minutes and a day";

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
	| { at: "step"; via: string; path: string; issue: StepIssue }
	/** Unfollowed function call. */
	| { at: "call"; function: string; message: string; why: Unfollowed | "private" }
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
	/** How many held automations point at a function. */
	pointing: (id: string) => number = () => 1,
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

	type Spanned = Omit<StepIssue, "param">;
	const unreadYet = (text: string): Spanned => ({ start: 0, end: text.length, message: "holes cannot be read yet" });

	/** A hole's issue in a text. */
	const holeIn = (text: string, names: readonly string[]): Spanned | null => {
		const holes = deps.holes?.();
		return holes ? holes.issue(text, names) : unreadYet(text);
	};

	/** A bare expression's issue. */
	const expressionIn = (source: string, names: readonly string[]): Spanned | null => {
		const holes = deps.holes?.();
		return holes ? holes.expression(source, names) : unreadYet(source);
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
				const issue = expressionIn(arg.text, names ?? []);
				if (issue) return { param: param.name, ...issue };
				continue;
			}
			const { value } = arg;
			literal[param.name] = value;
			if (names !== null && typeof value === "string" && hasHoles(value)) {
				if (param.kind !== "text")
					return { param: param.name, start: 0, end: value.length, message: "only a text takes a hole" };
				const issue = holeIn(value, names);
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

	type Checked = Pick<AutomationFunction, "params" | "steps">;

	const keptName = (step: FunctionStep): string | undefined =>
		step.kind === "let" ? step.name : step.kind === "start" || step.kind === "await" ? step.as : undefined;

	const keptNames = (fn: Checked): string[] =>
		stepsOf(fn).flatMap(({ step }) => {
			const name = keptName(step);
			return name === undefined ? [] : [name];
		});

	/** The run scopes `e` to a catch. */
	const namesIn = (fn: Checked): string[] => [...holeNames(TRIGGER_NAMES, fn.params), ...keptNames(fn), "e"];

	/** A name a kept value may not take. */
	const nameTaken = (fn: Checked, name: string): boolean =>
		name === "e" || TRIGGER_NAMES.includes(name) || fn.params.some((param) => param.name === name);

	const expressionIssue = (param: string, text: string, names: readonly string[]): StepIssue | null => {
		const issue = expressionIn(text, names);
		return issue ? { param, ...issue } : null;
	};

	const textIssue = (param: string, text: string, names: readonly string[]): StepIssue | null => {
		if (!hasHoles(text)) return null;
		const issue = holeIn(text, names);
		return issue ? { param, ...issue } : null;
	};

	/** A literal is as written. */
	const valueIssue = (param: string, arg: StepArg, names: readonly string[]): StepIssue | null =>
		arg.kind === "expression" ? expressionIssue(param, arg.text, names) : null;

	const STEPS: {
		[K in FunctionStep["kind"]]: (
			fn: Checked,
			step: Extract<FunctionStep, { kind: K }>,
			address: Address,
		) => StepIssue | null;
	} = {
		// Exit abandons sibling steps.
		exit: (_fn, _step, address) => (ownerOf(address) ? { message: EXIT_BESIDE } : null),
		note: () => null,
		unparsed: (fn, _step, address) =>
			address.length !== 1 || stepsOf(fn).length !== 1 ? { message: UNPARSED_ALONE } : null,
		try: () => null,
		parallel: (_fn, step) => (widthOf([step]) > RUN_STRANDS_MAX ? { message: TOO_WIDE } : null),
		start: (fn, step) => {
			if (step.as !== undefined && nameTaken(fn, step.as)) return { param: "as", message: NAME_TAKEN };
			return functionWidth(fn) > RUN_STRANDS_MAX ? { message: TOO_WIDE } : null;
		},
		await: (fn, step) => {
			if (step.as !== undefined && nameTaken(fn, step.as)) return { param: "as", message: NAME_TAKEN };
			return expressionIssue("task", step.task, namesIn(fn));
		},
		if: (fn, step) => expressionIssue("when", step.when, namesIn(fn)),
		let: (fn, step) => {
			if (nameTaken(fn, step.name)) return { param: "name", message: NAME_TAKEN };
			return valueIssue("value", step.value, namesIn(fn));
		},
		wait: (fn, step) => {
			if (step.minutes.kind === "expression") return expressionIssue("minutes", step.minutes.text, namesIn(fn));
			const minutes = step.minutes.kind === "literal" ? step.minutes.value : null;
			return typeof minutes === "number" && minutes >= 0 && minutes <= WAIT_MINUTES_MAX
				? null
				: { param: "minutes", message: WAIT_RANGE };
		},
		throw: (fn, step) => (step.text === undefined ? null : textIssue("text", step.text, namesIn(fn))),
		call: (fn, step) => {
			for (const [name, arg] of Object.entries(step.values ?? {})) {
				const issue = valueIssue(name, arg, namesIn(fn));
				if (issue) return issue;
			}
			return null;
		},
		do: (fn, step) => {
			if (!stepAction(step.action)) return { message: UNRUNNABLE, unrunnable: true };
			const row: AutomationActionRow = AUTOMATION_ACTIONS[step.action];
			const gives = STORES_RESULTS && row.gives !== undefined;
			if (step.as !== undefined && !gives) return { param: "as", message: GIVES_NOTHING };
			if (step.as !== undefined && nameTaken(fn, step.as)) return { param: "as", message: NAME_TAKEN };
			return argsIssue(step.action, step.args, namesIn(fn));
		},
	};

	const stepIssue = (fn: Checked, step: FunctionStep, address: Address): StepIssue | null =>
		(STEPS[step.kind] as (fn: Checked, step: FunctionStep, address: Address) => StepIssue | null)(
			fn,
			step,
			address,
		);

	/** Fit, then held switches. */
	function boundIssue(
		body: Automation,
		fn: AutomationFunction,
		values: Readonly<Record<string, FunctionValue>>,
		/** Values read only at the call's turn. */
		unjudged: ReadonlySet<string> = new Set(),
	): CallIssue | null {
		const given = givenOf(body.trigger);
		// An unjudged value stands as its declared type.
		const standing = Object.fromEntries(
			fn.params
				.filter((param) => unjudged.has(param.name))
				.map((param) => [param.name, param.type === "number" ? 0 : ""]),
		);
		if (!fitOf(given, { params: fn.params, reads: functionReads(fn) }, { ...values, ...standing }).fits)
			return { kind: "unfit" };
		const fromTrigger = new Set(given.names.map((held) => held.name));
		for (const param of fn.params) {
			if (param.type !== "device" || fromTrigger.has(param.name) || !Object.hasOwn(values, param.name)) continue;
			if (!switchHeld(values[param.name])) return { kind: "switch", param: param.name };
		}
		return null;
	}

	const callIssue = (body: Automation, fn: AutomationFunction): CallIssue | null => {
		const call = pointerOf(body);
		return call ? boundIssue(body, fn, call.values ?? {}) : null;
	};

	type CallStep = Extract<FunctionStep, { kind: "call" }>;

	/** Literals typed; expressions judged at entry. */
	function callFits(body: Automation, step: CallStep, callee: AutomationFunction): boolean {
		const literal: Record<string, FunctionValue> = {};
		const unjudged = new Set<string>();
		for (const [name, arg] of Object.entries(step.values ?? {})) {
			if (!callee.params.some((param) => param.name === name)) return false;
			const declared = callee.params.find((param) => param.name === name);
			// A string is a text, whatever its holes read.
			if (arg.kind === "expression" && declared?.type === "number" && writesText(arg.text)) return false;
			if (arg.kind !== "literal") unjudged.add(name);
			else if (typeof arg.value === "boolean") return false;
			else literal[name] = arg.value;
		}
		return boundIssue(body, callee, literal, unjudged) === null;
	}

	/** Its steps, then read values. */
	const calledEntryIssue = (
		body: Automation,
		id: string,
		fn: AutomationFunction,
		values: Readonly<Record<string, FunctionValue>>,
	): string | null => {
		const unsound = functionIssue(fn);
		if (unsound) return unsound.message;
		const issue = boundIssue(body, fn, values);
		return issue && lineOf({ at: "fit", function: id, issue });
	};

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
			loop: () => CALL_LOOPS,
			budget: () => CALLS_TOO_MUCH,
		};
		for (const at of functions ? reached(body, functions) : reached(body)) {
			const found = visit<WalkEntry, BodyIssue | null>(at, {
				action: ({ index, action }) => {
					const issue = argsIssue(action.kind, literalArgs(action), names);
					return issue && { at: "action", index, issue };
				},
				step: {
					do: ({ path, step, via, address }) => {
						const fn = functions?.(via);
						const issue = fn ? stepIssue(fn, step, address) : null;
						return issue && { at: "step", via, path, issue };
					},
					call: ({ path, step, via, address }): BodyIssue | null => {
						const fn = functions?.(via);
						const issue = fn ? stepIssue(fn, step, address) : null;
						if (issue) return { at: "step", via, path, issue };
						const callee = functions?.(step.function);
						if (callee && unnamed(callee))
							return { at: "call", function: step.function, message: FUNCTION_PRIVATE, why: "private" };
						return callee && !callFits(body, step, callee)
							? { at: "fit", function: step.function, issue: { kind: "unfit" } }
							: null;
					},
					...steering(({ path, step, via, address }) => {
						const fn = functions?.(via);
						const issue = fn ? stepIssue(fn, step, address) : null;
						return issue && { at: "step", via, path, issue };
					}),
				},
				unfollowedCall: ({ call, reason }) => {
					const message = unfollowed[reason](call.function);
					return message === null ? null : { at: "call", function: call.function, message, why: reason };
				},
			});
			if (found) yield found;
		}
		const call = functions ? pointerOf(body) : null;
		const fn = call ? functions?.(call.function) : null;
		// Its own steps, shared.
		if (call && fn && unnamed(fn) && pointing(call.function) > 1)
			yield { at: "call", function: call.function, message: FUNCTION_PRIVATE, why: "private" };
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
				return holeOwnerIssue({ step: String(held.index), param: held.issue.param }, held.issue);
			}
		}
		const [issue] = issues;
		return issue ? lineOf(issue) : null;
	}

	/** A word of the language, or an entity. */
	const reservedName = (name: string): boolean => RESERVED_NAMES.has(name) || deps.holes?.()?.entity(name) === true;

	/** A save's alone; stored rows are read as they are. */
	function namingIssue(fn: Checked): OwnerIssue | null {
		const param = fn.params.findIndex((held) => held.name === "e" || reservedName(held.name));
		if (param >= 0) return nameOwnerIssue(param, NAME_RESERVED);
		for (const { step, path } of stepsOf(fn)) {
			const kept = keptName(step);
			if (kept !== undefined && reservedName(kept)) {
				return stepOwnerIssue({ step: path, param: "name" }, NAME_RESERVED);
			}
		}
		return null;
	}

	/** First function-step issue. */
	function functionIssue(fn: AutomationFunction): OwnerIssue | null {
		for (const { step, path, address } of stepsOf(fn)) {
			const issue = stepIssue(fn, step, address);
			if (!issue) continue;
			if (holed(issue)) return holeOwnerIssue({ step: path, param: issue.param }, issue, "steps");
			return stepOwnerIssue({ step: path, param: issue.param }, issue.message);
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

	/** A call's read values, as the pointer its frame is entered by. */
	function resolvedCall(
		id: string,
		values: Readonly<Record<string, unknown>>,
	): { action: RunFunction } | { refused: string } {
		const kind: RunFunction["kind"] = "run_function";
		const parsed = AutomationActionSchema.safeParse({ kind, function: id, values });
		return parsed.success && parsed.data.kind === kind ? { action: parsed.data } : { refused: STEP_UNFIT };
	}

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

	return {
		triggerIssue,
		givenOf,
		assessBody,
		automationIssue,
		writeIssue,
		functionIssue,
		namingIssue,
		entryIssue,
		calledEntryIssue,
		resolved,
		resolvedCall,
		armed,
	};
}
