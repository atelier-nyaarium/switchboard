// What makes an automation invalid or inactive on this Gateway.

import { fitOf, functionReads, type TriggerGiven, triggerGiven } from "../../shared/automation-fit.js";
import {
	type Address,
	below,
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
	type WalkStep,
	widthOf,
} from "../../shared/automation-walk.js";
import { canonicalJson } from "../../shared/canonical-json.js";
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
	type FunctionArg,
} from "../../shared/schemasAutomation.js";
import {
	type AutomationIssue,
	type AutomationIssueLevel,
	ISSUE_LEVELS,
	type IssueCause,
	SAVE_LINE_MAX,
} from "../../shared/schemasAutomationSave.js";
import {
	type AutomationFunction,
	type FunctionStep,
	RUN_BRANCHES_MAX,
	type StepArg,
	unnamed,
	WAIT_MINUTES_MAX,
} from "../../shared/schemasFunction.js";
import { SCRIPT_RESERVED } from "../../shared/script-grammar.js";
import { choiceFieldOf, type SwitchCause, switchIssues } from "../../shared/switch-cases.js";
import { hasPlaceholders } from "../../shared/text-placeholders.js";
import type { OwnerIssue, OwnerRecord } from "../ownerRecords.js";
import { clockIssue, isClock } from "./automationClock.js";
import { ownerOf } from "./automationFrames.js";
import type { EffectKind } from "./automationRunner.js";
import { placeholderNames } from "./automationScope.js";
import type { AutomationsDeps } from "./automations.js";
import { stepOwnerIssue } from "./automationText.js";
import { crossingField } from "./crossingBand.js";

export type ValidityDeps = Pick<
	AutomationsDeps,
	"fields" | "reading" | "eventIssue" | "eventWarning" | "eventFields" | "eventChoices" | "placeholders" | "actions"
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
export const FUNCTION_LOOPS = "a function it runs leads back to itself";
export const FUNCTION_UNNAMED = "an unnamed function belongs to one automation; name it to share it";
export const FUNCTIONS_TOO_MANY = "it reaches too many functions or steps";
export const FUNCTION_UNREAD = "a newer version wrote the function it runs; update this Gateway";
export const FUNCTION_UNFIT = "it does not fit the function it runs";
export const NO_DEVICE = "no such device on this Gateway";
/** A step's values fail its action. */
export const STEP_UNFIT = "its values do not fit what it does";

const writesText = (source: string): boolean => {
	const { node } = parseConsoleExpression(source);
	return node?.kind === "template" || (node?.kind === "literal" && typeof node.value === "string");
};
const NO_ACTION = "this Gateway runs no such action";
const UNRUNNABLE = "a step does what this Gateway cannot run";
export const NAME_TAKEN = "that name is already taken here";
export const NAME_RESERVED = "that name is reserved";
export const RETURN_IN_BRANCH = "a return here would leave other branches running";
export const TOO_WIDE = `more than ${RUN_BRANCHES_MAX} steps would run at once`;
export const UNPARSED_ALONE = "a script with errors stands alone in its function";

/** Words the language reserves. */
const RESERVED_NAMES = new Set<string>([...SCRIPT_RESERVED, ...CONSOLE_WORD_OPS, "true", "false", "null"]);
export const GIVES_NOTHING = "this action gives no value";

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
	/** A switch case's number. */
	case?: number;
	/** Value index in case. */
	chip?: number;
	value?: string;
	message: string;
	/** Absent: a plain error. */
	cause?: StepCause;
}

/** Store or judge refusal. */
const REFUSALS = { unrunnable: true, alone: true, loop: true, budget: true, unnamed: true, gone: true } as const;
type Refusal = keyof typeof REFUSALS;

export type StepCause = IssueCause | Extract<Refusal, "unrunnable" | "alone">;

/** Why a run function step cannot run its function. */
export type RunFunctionIssue = { kind: "unfit" } | { kind: "device"; param: string };

/** Why a run function step stops. */
export type RunFunctionCut =
	| Extract<Refusal, "loop" | "budget" | "unnamed" | "gone">
	| Extract<IssueCause, "left" | "unread">;

/** A run function step's path. */
export interface RunFunctionPlace {
	via: string;
	step: string;
}

export type BodyIssue =
	| { at: "trigger"; message: string }
	/** Missing choice option. */
	| { at: "choice"; message: string }
	| { at: "action"; index: number; issue: StepIssue }
	/** Function-relative step path. */
	| { at: "step"; via: string; step: string; issue: StepIssue }
	| { at: "runFunction"; function: string; why: RunFunctionCut }
	/** No place marks the automation's own action. */
	| { at: "fit"; function: string; issue: RunFunctionIssue; place?: RunFunctionPlace }
	/** Shadowing parameter. */
	| { at: "name"; function: string; param: string };

const CUT_LINES: Readonly<Record<RunFunctionCut, string>> = {
	loop: FUNCTION_LOOPS,
	budget: FUNCTIONS_TOO_MANY,
	unnamed: FUNCTION_UNNAMED,
	gone: FUNCTION_GONE,
	left: FUNCTION_LEFT,
	unread: FUNCTION_UNREAD,
};

const LINES: { [A in BodyIssue["at"]]: (issue: Extract<BodyIssue, { at: A }>) => string } = {
	trigger: (issue) => issue.message,
	choice: (issue) => issue.message,
	action: ({ issue }) => issue.message,
	step: ({ issue }) => issue.message,
	runFunction: (issue) => CUT_LINES[issue.why],
	fit: ({ issue }) => (issue.kind === "unfit" ? FUNCTION_UNFIT : NO_DEVICE),
	name: () => NAME_RESERVED,
};

export const lineOf = (issue: BodyIssue): string => (LINES[issue.at] as (held: BodyIssue) => string)(issue);

/** Store or judge refusal. */
export type IssueLevel = "refuses" | AutomationIssueLevel;

type Cause = IssueCause | Refusal;

const CAUSES: { [A in BodyIssue["at"]]: (issue: Extract<BodyIssue, { at: A }>) => Cause | undefined } = {
	trigger: () => "trigger",
	choice: () => "vanished",
	action: ({ issue }) => issue.cause,
	step: ({ issue }) => issue.cause,
	runFunction: (issue) => issue.why,
	fit: () => "unfit",
	name: () => "shadows",
};

const refuses = (cause: Cause): cause is Refusal => Object.hasOwn(REFUSALS, cause);

/** Absent: a plain error. */
const causeLevel = (cause: Cause | undefined): IssueLevel => {
	if (cause === undefined) return "error";
	return refuses(cause) ? "refuses" : ISSUE_LEVELS[cause];
};

const stepLevel = (issue: StepIssue): IssueLevel => causeLevel(issue.cause);

/** One level per cause; see docs/fields.md. */
export const levelOf = (issue: BodyIssue): IssueLevel =>
	causeLevel((CAUSES[issue.at] as (held: BodyIssue) => Cause | undefined)(issue));

const deactivates = (issue: BodyIssue): boolean => {
	const level = levelOf(issue);
	return level === "refuses" || level === "inactive";
};

const stops = (level: IssueLevel): boolean => level === "refuses" || level === "error";

const line = (text: string): string => text.slice(0, SAVE_LINE_MAX);

const spanOf = (issue: StepIssue) => ({
	...(issue.param === undefined ? {} : { param: issue.param }),
	...(issue.start === undefined ? {} : { start: issue.start }),
	...(issue.end === undefined ? {} : { end: issue.end }),
	...(issue.case === undefined ? {} : { case: issue.case }),
	...(issue.value === undefined ? {} : { value: issue.value.slice(0, SAVE_LINE_MAX) }),
});

const SWITCH_LINES: Readonly<Record<SwitchCause, (value: string) => string>> = {
	empty_case: () => "a case holds no value",
	repeated_value: () => "this value is given before",
	vanished: (value) => `${value} is no longer one of its values`,
};

/** Switch issues by case. */
const caseIssues = (step: Extract<FunctionStep, { kind: "switch" }>, choices: readonly string[] | null): StepIssue[] =>
	switchIssues(step, choices).map(({ cause, case: at, chip, value }) => ({
		case: at,
		...(chip === undefined ? {} : { chip }),
		...(value === undefined ? {} : { value }),
		message: SWITCH_LINES[cause](value ?? ""),
		cause,
	}));

const ANSWERS: {
	[A in BodyIssue["at"]]: (issue: Extract<BodyIssue, { at: A }>, level: AutomationIssueLevel) => AutomationIssue;
} = {
	trigger: (issue, level) => ({ level, record: "automation", line: line(issue.message) }),
	choice: (issue, level) => ({ level, record: "automation", line: line(issue.message) }),
	action: ({ index, issue }, level) => ({
		level,
		record: "automation",
		step: String(index),
		...spanOf(issue),
		line: line(issue.message),
	}),
	step: ({ via, step, issue }, level) => ({
		level,
		record: "function",
		id: via,
		step,
		...spanOf(issue),
		line: line(issue.message),
	}),
	runFunction: (issue, level) => ({ level, record: "function", id: issue.function, line: CUT_LINES[issue.why] }),
	fit: (issue, level) => {
		const param = issue.issue.kind === "device" ? { param: issue.issue.param } : {};
		const text = lineOf(issue);
		return issue.place
			? { level, record: "function", id: issue.place.via, step: issue.place.step, ...param, line: text }
			: { level, record: "automation", ...param, line: text };
	},
	name: (issue, level) => ({
		level,
		record: "function",
		id: issue.function,
		param: issue.param,
		line: NAME_RESERVED,
	}),
};

/** Landed issues, each once. */
export function answersOf(issues: Iterable<BodyIssue>): AutomationIssue[] {
	const seen = new Set<string>();
	const answers: AutomationIssue[] = [];
	for (const issue of issues) {
		const level = levelOf(issue);
		if (level === "refuses") continue;
		const answer = (ANSWERS[issue.at] as (held: BodyIssue, at: AutomationIssueLevel) => AutomationIssue)(
			issue,
			level,
		);
		const key = canonicalJson(answer);
		if (seen.has(key)) continue;
		seen.add(key);
		answers.push(answer);
	}
	return answers;
}

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

	/** A choice subject's options. */
	const choicesOf = (trigger: AutomationTrigger, subject: string): readonly string[] | null => {
		const field = trigger.kind === "event" ? choiceFieldOf(subject) : null;
		return trigger.kind === "event" && field !== null ? (deps.eventChoices?.(trigger.source, field) ?? null) : null;
	};

	const deviceHeld = (device: unknown): boolean =>
		typeof device === "string" && (deps.actions?.deviceName(device) ?? null) !== null;

	type Spanned = Omit<StepIssue, "param">;
	const unreadYet = (text: string): Spanned => ({
		start: 0,
		end: text.length,
		message: "placeholders cannot be read yet",
		cause: "unready",
	});

	/** A placeholder's issue in a text. */
	const placeholderIn = (text: string, names: readonly string[]): Spanned | null => {
		const placeholders = deps.placeholders?.();
		return placeholders ? placeholders.issue(text, names) : unreadYet(text);
	};

	/** A bare expression's issue. */
	const expressionIn = (source: string, names: readonly string[]): Spanned | null => {
		const placeholders = deps.placeholders?.();
		return placeholders ? placeholders.expression(source, names) : unreadYet(source);
	};

	/** Null names skip placeholders. */
	function argsIssue(
		kind: string,
		args: Readonly<Record<string, StepArg>>,
		names: readonly string[] | null,
	): StepIssue | null {
		if (!stepAction(kind)) return { message: UNRUNNABLE, cause: "unrunnable" };
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
			if (names !== null && typeof value === "string" && hasPlaceholders(value)) {
				if (param.kind !== "text")
					return {
						param: param.name,
						start: 0,
						end: value.length,
						message: "only a text takes a placeholder",
					};
				const issue = placeholderIn(value, names);
				if (issue) return { param: param.name, ...issue };
				continue;
			}
			if (param.kind === "device" && !deviceHeld(value)) return { param: param.name, message: NO_DEVICE };
			if (param.kind === "choice" && !(param.options ?? []).some((option) => option.value === value))
				return { param: param.name, message: `${String(value)} is not one of its values` };
		}
		if (literalOnly && !AutomationActionSchema.safeParse(literal).success) return { message: STEP_UNFIT };
		return null;
	}

	type Checked = Pick<AutomationFunction, "params" | "steps">;

	const variableName = (step: FunctionStep): string | undefined =>
		step.kind === "variable" ? step.name : step.kind === "start" || step.kind === "await" ? step.as : undefined;

	const variableNames = (fn: Checked): string[] =>
		stepsOf(fn).flatMap(({ step }) => {
			const name = variableName(step);
			return name === undefined ? [] : [name];
		});

	/** The run scopes `e` to a catch. */
	const namesIn = (fn: Checked): string[] => [
		...placeholderNames(TRIGGER_NAMES, fn.params),
		...variableNames(fn),
		"e",
	];

	/** A name a variable may not take. */
	const nameTaken = (fn: Checked, name: string): boolean =>
		name === "e" || TRIGGER_NAMES.includes(name) || fn.params.some((param) => param.name === name);

	const expressionIssue = (param: string, text: string, names: readonly string[]): StepIssue | null => {
		const issue = expressionIn(text, names);
		return issue ? { param, ...issue } : null;
	};

	const textIssue = (param: string, text: string, names: readonly string[]): StepIssue | null => {
		if (!hasPlaceholders(text)) return null;
		const issue = placeholderIn(text, names);
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
		// Return abandons sibling branches.
		return: (_fn, _step, address) => (ownerOf(address) ? { message: RETURN_IN_BRANCH } : null),
		comment: () => null,
		unparsed: (fn, _step, address) =>
			address.length !== 1 || stepsOf(fn).length !== 1 ? { message: UNPARSED_ALONE, cause: "alone" } : null,
		try: () => null,
		parallel: (_fn, step) => (widthOf([step]) > RUN_BRANCHES_MAX ? { message: TOO_WIDE } : null),
		start: (fn, step) => {
			if (step.as !== undefined && nameTaken(fn, step.as)) return { param: "as", message: NAME_TAKEN };
			return functionWidth(fn) > RUN_BRANCHES_MAX ? { message: TOO_WIDE } : null;
		},
		await: (fn, step) => {
			if (step.as !== undefined && nameTaken(fn, step.as)) return { param: "as", message: NAME_TAKEN };
			return expressionIssue("task", step.task, namesIn(fn));
		},
		if: (fn, step) => expressionIssue("condition", step.condition, namesIn(fn)),
		switch: (fn, step) =>
			expressionIssue("subject", step.subject, namesIn(fn)) ?? caseIssues(step, null)[0] ?? null,
		variable: (fn, step) => {
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
		run_function: (fn, step) => {
			for (const [name, arg] of Object.entries(step.args ?? {})) {
				const issue = valueIssue(name, arg, namesIn(fn));
				if (issue) return issue;
			}
			return null;
		},
		action: (fn, step) => {
			if (!stepAction(step.action)) return { message: UNRUNNABLE, cause: "unrunnable" };
			const row: AutomationActionRow = AUTOMATION_ACTIONS[step.action];
			const gives = STORES_RESULTS && row.gives !== undefined;
			if (step.as !== undefined && !gives) return { param: "as", message: GIVES_NOTHING };
			if (step.as !== undefined && nameTaken(fn, step.as)) return { param: "as", message: NAME_TAKEN };
			return argsIssue(step.action, step.args, namesIn(fn));
		},
	};

	/** Reserved name or entity. */
	const reservedName = (name: string): boolean =>
		RESERVED_NAMES.has(name) || deps.placeholders?.()?.entity(name) === true;

	/** Errors before shadowing names. */
	const stepIssue = (fn: Checked, step: FunctionStep, address: Address): StepIssue | null => {
		const issue = (STEPS[step.kind] as (fn: Checked, step: FunctionStep, address: Address) => StepIssue | null)(
			fn,
			step,
			address,
		);
		if (issue) return issue;
		const named = variableName(step);
		if (named === undefined || !reservedName(named)) return null;
		return { param: step.kind === "variable" ? "name" : "as", message: NAME_RESERVED, cause: "shadows" };
	};

	/** Primary issue first. */
	const issuesAt = (
		fn: Checked,
		step: FunctionStep,
		address: Address,
		trigger: AutomationTrigger | null,
	): StepIssue[] => {
		const issue = stepIssue(fn, step, address);
		if (step.kind !== "switch") return issue ? [issue] : [];
		const choices = trigger ? choicesOf(trigger, step.subject) : null;
		const rest = caseIssues(step, choices).filter((held) => held.case !== issue?.case || held.chip !== issue?.chip);
		return [...(issue ? [issue] : []), ...rest];
	};

	const stepStops = (fn: Checked, step: FunctionStep, address: Address): boolean => {
		const issue = stepIssue(fn, step, address);
		return issue !== null && stops(stepLevel(issue));
	};

	/** Fit, then held devices. */
	function boundIssue(
		body: Automation,
		fn: AutomationFunction,
		args: Readonly<Record<string, FunctionArg>>,
		/** Arguments read only at the step's turn. */
		unjudged: ReadonlySet<string> = new Set(),
	): RunFunctionIssue | null {
		const given = givenOf(body.trigger);
		// An unjudged argument stands as its declared type.
		const standing = Object.fromEntries(
			fn.params
				.filter((param) => unjudged.has(param.name))
				.map((param) => [param.name, param.type === "number" ? 0 : ""]),
		);
		if (!fitOf(given, { params: fn.params, reads: functionReads(fn) }, { ...args, ...standing }).fits)
			return { kind: "unfit" };
		const fromTrigger = new Set(given.names.map((held) => held.name));
		for (const param of fn.params) {
			if (param.type !== "device" || fromTrigger.has(param.name) || !Object.hasOwn(args, param.name)) continue;
			if (!deviceHeld(args[param.name])) return { kind: "device", param: param.name };
		}
		return null;
	}

	const pointerIssue = (body: Automation, fn: AutomationFunction): RunFunctionIssue | null => {
		const pointer = pointerOf(body);
		return pointer ? boundIssue(body, fn, pointer.args ?? {}) : null;
	};

	type RunFunctionStep = Extract<FunctionStep, { kind: "run_function" }>;

	/** Literals typed; expressions judged at entry. */
	function runFunctionFits(body: Automation, step: RunFunctionStep, callee: AutomationFunction): boolean {
		const literal: Record<string, FunctionArg> = {};
		const unjudged = new Set<string>();
		for (const [name, arg] of Object.entries(step.args ?? {})) {
			if (!callee.params.some((param) => param.name === name)) return false;
			const declared = callee.params.find((param) => param.name === name);
			// A string is a text, whatever its placeholders read.
			if (arg.kind === "expression" && declared?.type === "number" && writesText(arg.text)) return false;
			if (arg.kind !== "literal") unjudged.add(name);
			else if (typeof arg.value === "boolean") return false;
			else literal[name] = arg.value;
		}
		return boundIssue(body, callee, literal, unjudged) === null;
	}

	/** Read arguments only. */
	const runFunctionEntryIssue = (
		body: Automation,
		id: string,
		fn: AutomationFunction,
		args: Readonly<Record<string, FunctionArg>>,
	): string | null => {
		const issue = boundIssue(body, fn, args);
		return issue && lineOf({ at: "fit", function: id, issue });
	};

	/** The automation's own arguments only. */
	const entryIssue = (body: Automation, id: string, fn: AutomationFunction): string | null => {
		const issue = pointerIssue(body, fn);
		return issue && lineOf({ at: "fit", function: id, issue });
	};

	/** Null lookup, flat walk. */
	function* assessBody(body: Automation, functions: FunctionOf | null = functionOf): Generator<BodyIssue> {
		const trigger = triggerIssue(body);
		if (trigger !== null) yield { at: "trigger", message: trigger };
		const healed = body.trigger.kind === "event" ? (deps.eventWarning?.(body.trigger) ?? null) : null;
		if (healed !== null) yield { at: "choice", message: healed };
		const names = AUTOMATION_TRIGGER_NAMES[body.trigger.kind];
		const cuts: Record<Unfollowed, (id: string) => RunFunctionCut | null> = {
			"not-expanded": () => null,
			// Moves strip event users.
			missing: (id) => (unread(id) ? "unread" : body.trigger.kind === "event" ? "left" : "gone"),
			loop: () => "loop",
			budget: () => "budget",
		};
		const entered: string[] = [];
		/** Numbers under its function. */
		const placeOf = <K extends FunctionStep["kind"]>(at: WalkStep<K>): string => below(at.path, at.site).join(".");
		const own = <K extends FunctionStep["kind"]>(at: WalkStep<K>): BodyIssue[] => {
			if (!entered.includes(at.via)) entered.push(at.via);
			const fn = functions?.(at.via);
			const issues = fn ? issuesAt(fn, at.step, at.address, body.trigger) : [];
			return issues.map((issue) => ({ at: "step", via: at.via, step: placeOf(at), issue }));
		};
		for (const at of functions ? reached(body, functions) : reached(body)) {
			const found = visit<WalkEntry, BodyIssue[]>(at, {
				action: ({ index, action }) => {
					const issue = argsIssue(action.kind, literalArgs(action), names);
					return issue ? [{ at: "action", index, issue }] : [];
				},
				step: {
					action: own,
					run_function: (held): BodyIssue[] => {
						const id = held.step.function;
						const callee = functions?.(id);
						if (callee && unnamed(callee))
							return [...own(held), { at: "runFunction", function: id, why: "unnamed" }];
						if (!callee || runFunctionFits(body, held.step, callee)) return own(held);
						const place = { via: held.via, step: placeOf(held) };
						return [...own(held), { at: "fit", function: id, issue: { kind: "unfit" }, place }];
					},
					...steering(own),
				},
				unfollowedFunction: ({ runFunction, reason }) => {
					const why = cuts[reason](runFunction.function);
					return why === null ? [] : [{ at: "runFunction", function: runFunction.function, why }];
				},
			});
			yield* found;
		}
		for (const id of entered) {
			const fn = functions?.(id);
			for (const param of fn?.params ?? []) {
				if (param.name === "e" || reservedName(param.name))
					yield { at: "name", function: id, param: param.name };
			}
		}
		const pointer = functions ? pointerOf(body) : null;
		const fn = pointer ? functions?.(pointer.function) : null;
		// Its own steps, shared.
		if (pointer && fn && unnamed(fn) && pointing(pointer.function) > 1)
			yield { at: "runFunction", function: pointer.function, why: "unnamed" };
		const unfit = pointer && fn ? pointerIssue(body, fn) : null;
		if (pointer && unfit) yield { at: "fit", function: pointer.function, issue: unfit };
	}

	const first = (issues: Iterable<BodyIssue>, picked: (issue: BodyIssue) => boolean): BodyIssue | null => {
		for (const issue of issues) if (picked(issue)) return issue;
		return null;
	};

	/** Recomputed issue that leaves it inactive. */
	const automationIssue = (body: Automation, functions: FunctionOf | null = functionOf): string | null => {
		const issue = first(assessBody(body, functions), deactivates);
		return issue && lineOf(issue);
	};

	/** Current issues, once each. */
	const issuesOf = (body: Automation, functions: FunctionOf = functionOf): AutomationIssue[] =>
		answersOf(assessBody(body, functions));

	function writeIssue(body: Automation, functions: FunctionOf): string | null {
		const issue = first(assessBody(body, functions), (held) => levelOf(held) === "refuses");
		return issue && lineOf(issue);
	}

	/** First refused function step. */
	function functionIssue(fn: AutomationFunction): OwnerIssue | null {
		for (const { step, path, address } of stepsOf(fn)) {
			const issue = stepIssue(fn, step, address);
			if (issue && stepLevel(issue) === "refuses")
				return stepOwnerIssue({ step: path, param: issue.param }, issue.message);
		}
		return null;
	}

	/** Trigger enables choice warnings. */
	function stepIssuesOf(
		fn: AutomationFunction,
		trigger?: AutomationTrigger,
	): (StepIssue & { step: string; level: IssueLevel })[] {
		return stepsOf(fn).flatMap(({ step, path, address }) =>
			issuesAt(fn, step, address, trigger ?? null).map((issue) => ({
				...issue,
				step: path,
				level: stepLevel(issue),
			})),
		);
	}

	const actionStops = (body: Automation, action: LeafAction): boolean => {
		const issue = argsIssue(action.kind, literalArgs(action), AUTOMATION_TRIGGER_NAMES[body.trigger.kind]);
		return issue !== null && stops(stepLevel(issue));
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

	/** A run function step's read arguments, as the action its frame is entered by. */
	function resolvedRunFunction(
		id: string,
		args: Readonly<Record<string, unknown>>,
	): { action: RunFunction } | { refused: string } {
		const kind: RunFunction["kind"] = "run_function";
		const parsed = AutomationActionSchema.safeParse({ kind, function: id, args });
		return parsed.success && parsed.data.kind === kind ? { action: parsed.data } : { refused: STEP_UNFIT };
	}

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

	return {
		triggerIssue,
		givenOf,
		choicesOf,
		assessBody,
		automationIssue,
		issuesOf,
		writeIssue,
		functionIssue,
		stepIssuesOf,
		actionStops,
		stepStops,
		entryIssue,
		runFunctionEntryIssue,
		resolved,
		resolvedRunFunction,
		armed,
	};
}
