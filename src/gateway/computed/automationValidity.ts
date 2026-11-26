// What makes an automation invalid or unarmed on this Gateway.

import { fitOf, functionReads, type TriggerGiven, triggerGiven } from "../../shared/automation-fit.js";
import { type FunctionOf, reached, written } from "../../shared/automation-walk.js";
import {
	AUTOMATION_ACTIONS,
	AUTOMATION_TRIGGER_NAMES,
	type Automation,
	type AutomationAction,
	type AutomationActionParam,
	AutomationActionSchema,
	type AutomationTrigger,
	FUNCTION_STEP_KINDS,
} from "../../shared/schemasAutomation.js";
import type { AutomationFunction, FunctionStep } from "../../shared/schemasFunction.js";
import { hasHoles } from "../../shared/text-holes.js";
import type { OwnerIssue, OwnerRecord } from "../ownerRecords.js";
import { clockIssue, isClock } from "./automationClock.js";
import { type EffectKind, effectIssue, isEffect } from "./automationRunner.js";
import { holeNames } from "./automationScope.js";
import type { AutomationsDeps } from "./automations.js";
import { holeOwnerIssue, holeTexts } from "./automationText.js";
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

/** Spans as written. */
export interface StepIssue {
	param?: string;
	start?: number;
	end?: number;
	message: string;
}

/** Why a call cannot run its function. */
export type CallIssue = { kind: "unfit" } | { kind: "switch"; param: string };

const callLine = (issue: CallIssue): string => (issue.kind === "unfit" ? FUNCTION_UNFIT : NO_SWITCH);

type Call = Extract<AutomationAction, { kind: "run_function" }>;

const callOf = (body: Automation): Call | null => {
	for (const { action } of reached(body)) if (action.kind === "run_function") return action;
	return null;
};

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

	/** First refused hole and span. */
	function holesIssue(body: Automation): OwnerIssue | null {
		const holes = deps.holes?.();
		const names = AUTOMATION_TRIGGER_NAMES[body.trigger.kind];
		for (const at of holeTexts(body)) {
			if (!hasHoles(at.text)) continue;
			if (!holes)
				return holeOwnerIssue(at, { start: 0, end: at.text.length, message: "holes cannot be read yet" });
			const issue = holes.issue(at.text, names);
			if (issue) return holeOwnerIssue(at, issue);
		}
		return null;
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

	/** What a flat action of its kind is checked for. */
	function stepIssue(fn: Pick<AutomationFunction, "params">, step: FunctionStep): StepIssue | null {
		if (step.as !== undefined) return { message: "a step cannot keep its result yet" };
		const kind = step.action;
		if (!stepAction(kind)) return { message: "a step does what this Gateway cannot run" };
		if (kind !== "tell_assistant" && !deps.actions) return { message: "this Gateway runs no such action" };
		const params: readonly AutomationActionParam[] = AUTOMATION_ACTIONS[kind].params;
		for (const name of Object.keys(step.args)) {
			if (!params.some((param) => param.name === name)) return { param: name, message: `it takes no ${name}` };
		}
		for (const param of params) {
			if (!param.optional && !Object.hasOwn(step.args, param.name))
				return { param: param.name, message: `${param.label} is missing` };
		}
		const names = holeNames(TRIGGER_NAMES, fn.params);
		const literal: Record<string, unknown> = { kind };
		let literalOnly = true;
		for (const param of params) {
			const arg = Object.hasOwn(step.args, param.name) ? step.args[param.name] : undefined;
			if (!arg) continue;
			if (arg.kind === "expression") {
				literalOnly = false;
				const issue = holeIn(`{${arg.text}}`, names, 1);
				if (issue) return { param: param.name, ...issue };
				continue;
			}
			const { value } = arg;
			literal[param.name] = value;
			if (typeof value === "string" && hasHoles(value)) {
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

	/** A function row's first step issue, by its address. */
	function functionIssue(fn: AutomationFunction): OwnerIssue | null {
		for (const [index, step] of written(fn).entries()) {
			const issue = stepIssue(fn, step);
			if (!issue) continue;
			if (issue.start !== undefined && issue.end !== undefined && issue.param !== undefined) {
				return holeOwnerIssue(
					{ action: index, param: issue.param },
					{ start: issue.start, end: issue.end, message: issue.message },
					"steps",
				);
			}
			return {
				path: ["steps", index, ...(issue.param ? [issue.param] : [])],
				message: issue.message,
				code: STEP_ISSUE_CODE,
			};
		}
		return null;
	}

	/** Fit, then each device value against the switches. */
	function callIssue(body: Automation, fn: AutomationFunction): CallIssue | null {
		const call = callOf(body);
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

	/** `deep` reads its function's steps and fit. */
	function issueOf(body: Automation, functions: FunctionOf | null, deep: boolean): string | null {
		const issue = triggerIssue(body);
		if (issue !== null) return issue;
		for (const at of functions ? reached(body, functions) : reached(body)) {
			if (!("action" in at)) {
				if (!stepAction(at.kind)) return "a step does what this Gateway cannot run";
				const fn = deep && functions ? functions(at.via) : null;
				const step = fn ? stepIssue(fn, at.step) : null;
				if (step) return step.message;
				continue;
			}
			if (at.action.kind === "run_function") {
				if (!functions) continue;
				if (unread(at.action.function)) return FUNCTION_UNREAD;
				// Only a move strips an event user.
				return body.trigger.kind === "event" ? FUNCTION_LEFT : FUNCTION_GONE;
			}
			const refused = isEffect(at.action) ? effectIssue(at.action, deps.actions) : null;
			if (refused !== null) return refused;
		}
		const call = deep && functions ? callOf(body) : null;
		const fn = call && functions ? functions(call.function) : null;
		const unfit = fn ? callIssue(body, fn) : null;
		if (unfit) return callLine(unfit);
		return holesIssue(body)?.message ?? null;
	}

	/** Why this Gateway cannot run it; read every time. */
	const automationIssue = (body: Automation, functions: FunctionOf = functionOf): string | null =>
		issueOf(body, functions, true);

	/** What a write refuses; a function's fit is the judge's. */
	const writeIssue = (body: Automation, functions: FunctionOf = functionOf): string | null =>
		issueOf(body, functions, false);

	/** Frame judges the function. */
	const bodyIssue = (body: Automation): string | null => issueOf(body, null, false);

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

	return {
		triggerIssue,
		holesIssue,
		givenOf,
		stepIssue,
		functionIssue,
		callIssue,
		automationIssue,
		writeIssue,
		bodyIssue,
		armed,
	};
}
