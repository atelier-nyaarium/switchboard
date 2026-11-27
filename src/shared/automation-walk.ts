// The one walk over what an automation does.

import type { z } from "zod";
import type { AutomationAction } from "./schemasAutomation.js";
import type { AutomationFunction, FunctionStep } from "./schemasFunction.js";

declare const opened: unique symbol;

/** A list only this module opens. */
export interface Sealed<T> {
	readonly [opened]: readonly T[];
}

/** The codegen reads `walked`. */
export const walked = <T extends z.ZodType>(list: z.ZodArray<T>) =>
	list.transform((items) => items as unknown as Sealed<z.output<T>>).meta({ walked: true });

const open = <T>(list: Sealed<T>): readonly T[] => list as unknown as readonly T[];

export type RunFunction = Extract<AutomationAction, { kind: "run_function" }>;

export type LeafAction = Exclude<AutomationAction, RunFunction>;

type StepKind = FunctionStep["kind"];

/** As written. */
export interface WalkAction {
	reach: "action";
	path: string;
	index: number;
	action: LeafAction;
}

/** Called function step, at any depth. */
export interface WalkStep<K extends StepKind = StepKind> {
	reach: "step";
	path: string;
	/** Its call's path. */
	site: string;
	/** In its own list. */
	index: number;
	/** In its function's body. */
	address: Address;
	step: Extract<FunctionStep, { kind: K }>;
	via: string;
}

/** Unexpanded, not held, already above it, or past the walk's bound. */
export type Unfollowed = "not-expanded" | "missing" | "loop" | "budget";

/** Steps one walk answers before it follows no further call. */
export const WALK_ENTRIES_MAX = 256;
/** Functions one run may enter; a walk follows no call past it. */
export const RUN_FRAMES_MAX = 16;

export interface UnfollowedCall<R extends Unfollowed = Unfollowed> {
	reach: "unfollowedCall";
	path: string;
	call: RunFunction;
	reason: R;
}

export type WalkEntry = WalkAction | WalkStep | UnfollowedCall;
/** Walked without functions. */
export type FlatEntry = WalkAction | UnfollowedCall<"not-expanded">;
export type FollowedEntry = WalkAction | WalkStep | UnfollowedCall<"missing" | "loop" | "budget">;

/** Exhaustive walk handlers. */
export type WalkHandlers<E extends WalkEntry, R> = {
	[A in E["reach"]]: A extends "step"
		? { [K in StepKind]: (at: WalkStep<K>) => R }
		: (at: Extract<E, { reach: A }>) => R;
};

/** Kinds that steer or hold steps and act on nothing themselves. A new kind joins by hand. */
export const STEERING = [
	"if",
	"try",
	"parallel",
	"start",
	"await",
	"exit",
	"throw",
	"let",
	"wait",
	"note",
	"unparsed",
] as const satisfies readonly StepKind[];
type Steering = (typeof STEERING)[number];

/** One answer for every steering kind. */
export const steering = <R>(answer: (at: WalkStep<Steering>) => R): { [K in Steering]: (at: WalkStep<K>) => R } =>
	Object.fromEntries(STEERING.map((kind) => [kind, answer])) as { [K in Steering]: (at: WalkStep<K>) => R };

export function visit<E extends WalkEntry, R>(entry: E, handlers: WalkHandlers<E, R>): R {
	const at: WalkEntry = entry;
	const all = handlers as unknown as WalkHandlers<WalkEntry, R>;
	switch (at.reach) {
		case "action":
			return all.action(at);
		case "step":
			return (all.step[at.step.kind] as (held: WalkStep) => R)(at);
		case "unfollowedCall":
			return all.unfollowedCall(at);
	}
}

/** Null when not held. */
export type FunctionOf = (id: string) => AutomationFunction | null;

type Walked = { actions: Sealed<AutomationAction> };

/** Concurrent `parallel` and `start`. */
export const SIDES = ["then", "else", "try", "catch", "parallel", "start"] as const;
export type Side = (typeof SIDES)[number];

/** Within one body: indexes and sides, ending on an index. */
export type Address = readonly (number | Side)[];

/** A step's first list is 0, its second 1. */
export const sideNumber = (side: Side): 0 | 1 => (side === "else" || side === "catch" ? 1 : 0);

/** Numbers alone: a call, an index and a side each read as one. */
export const STEP_PATH_RE = /^\d+(\.\d+)*$/;

const numbered = (address: Address): number[] =>
	address.map((segment) => (typeof segment === "number" ? segment : sideNumber(segment)));

/** A step of the body the call at `site` runs. */
export const within = (site: string, address: Address): string => [site, ...numbered(address)].join(".");

/** The call a step runs under: the longest of `sites` above it. */
export const siteAmong = (path: string, sites: Iterable<string>): string | null => {
	let found: string | null = null;
	for (const site of sites) {
		if (path.startsWith(`${site}.`) && (found === null || site.length > found.length)) found = site;
	}
	return found;
};

/** Its numbers below `site`; the body they address names the sides. */
export const below = (path: string, site: string): number[] =>
	path
		.slice(site.length + 1)
		.split(".")
		.map(Number);

/** Written order: a step before what it holds. */
export const byPath = (a: string, b: string): number => {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let at = 0; at < Math.min(left.length, right.length); at++) {
		const order = (left[at] as number) - (right[at] as number);
		if (order !== 0) return order;
	}
	return left.length - right.length;
};

export function reached(automation: Walked): FlatEntry[];
export function reached(automation: Walked, functionOf: FunctionOf): FollowedEntry[];
export function reached(automation: Walked, functionOf?: FunctionOf): WalkEntry[] {
	const budget = { left: WALK_ENTRIES_MAX, frames: RUN_FRAMES_MAX };
	return open(automation.actions).flatMap((action, at): WalkEntry[] => {
		const path = String(at);
		if (action.kind !== "run_function") return [{ reach: "action", path, index: at, action }];
		if (!functionOf) return [{ reach: "unfollowedCall", path, call: action, reason: "not-expanded" }];
		return followed(action, path, [], functionOf, budget);
	});
}

/** Steps under the call's path. */
function followed(
	call: RunFunction,
	site: string,
	chain: readonly string[],
	functionOf: FunctionOf,
	budget: { left: number; frames: number },
): WalkEntry[] {
	const unfollowed = (reason: "missing" | "loop" | "budget"): WalkEntry[] => [
		{ reach: "unfollowedCall", path: site, call, reason },
	];
	if (chain.includes(call.function)) return unfollowed("loop");
	const fn = functionOf(call.function);
	if (!fn) return unfollowed("missing");
	const steps = stepsIn(open(fn.steps), []);
	if (steps.length > budget.left || budget.frames === 0) return unfollowed("budget");
	budget.left -= steps.length;
	budget.frames -= 1;
	const above = [...chain, call.function];
	return steps.flatMap(({ address, step }): WalkEntry[] => {
		const path = within(site, address);
		const here: WalkStep = {
			reach: "step",
			path,
			site,
			index: address.at(-1) as number,
			address,
			step,
			via: call.function,
		};
		if (step.kind !== "call") return [here];
		const inner: RunFunction = { kind: "run_function", function: step.function };
		return [here, ...followed(inner, path, above, functionOf, budget)];
	});
}

/** Every step at every depth, a step before what it holds. */
function stepsIn(steps: readonly FunctionStep[], base: Address): { address: Address; step: FunctionStep }[] {
	return steps.flatMap((step, index) => {
		const address = [...base, index];
		const held = (side: Side, list: readonly FunctionStep[] | undefined) => stepsIn(list ?? [], [...address, side]);
		if (step.kind === "if") return [{ address, step }, ...held("then", step.steps), ...held("else", step.else)];
		if (step.kind === "try") return [{ address, step }, ...held("try", step.steps), ...held("catch", step.catch)];
		if (step.kind === "parallel") return [{ address, step }, ...held("parallel", step.steps)];
		if (step.kind === "start") return [{ address, step }, ...held("start", step.steps)];
		return [{ address, step }];
	});
}

/** A function's steps at every depth, each with its numbers under the function. */
export const stepsOf = (fn: {
	steps: Sealed<FunctionStep>;
}): { path: string; address: Address; step: FunctionStep }[] =>
	stepsIn(open(fn.steps), []).map(({ address, step }) => ({ path: numbered(address).join("."), address, step }));

interface Width {
	peak: number;
	rest: number;
}

const listWidth = (steps: readonly FunctionStep[]): Width => {
	let running = 0;
	let peak = 0;
	for (const step of steps) {
		const each = stepWidth(step);
		peak = Math.max(peak, running + each.peak);
		running += each.rest;
	}
	return { peak, rest: running };
};

const widest = (...lists: readonly (readonly FunctionStep[])[]): Width => {
	const widths = lists.map(listWidth);
	return { peak: Math.max(1, ...widths.map((w) => w.peak)), rest: Math.max(0, ...widths.map((w) => w.rest)) };
};

function stepWidth(step: FunctionStep): Width {
	switch (step.kind) {
		// Block waits for its branches.
		case "parallel":
			return {
				peak: Math.max(
					1,
					step.steps.reduce((sum, each) => sum + listWidth([each]).peak, 0),
				),
				rest: 0,
			};
		// Task runs beside the cursor.
		case "start": {
			const task = listWidth(step.steps).peak;
			return { peak: task + 1, rest: task };
		}
		case "if":
			return widest(step.steps ?? [], step.else ?? []);
		// A catch runs while what the try started still runs.
		case "try": {
			const body = listWidth(step.steps);
			const handler = listWidth(step.catch);
			return { peak: Math.max(1, body.peak, body.rest + handler.peak), rest: body.rest + handler.rest };
		}
		default:
			return { peak: 1, rest: 0 };
	}
}

export const widthOf = (steps: readonly FunctionStep[]): number => Math.max(1, listWidth(steps).peak);

/** A whole function's peak width. */
export const functionWidth = (fn: { steps: Sealed<FunctionStep> }): number => widthOf(open(fn.steps));

/** The functions a function's steps call, at any depth. */
export const callsOf = (fn: { steps: Sealed<FunctionStep> }): string[] =>
	stepsOf(fn).flatMap(({ step }) => (step.kind === "call" ? [step.function] : []));

/** Every function a run can enter. */
export function reachOf(automation: Walked, functionOf: FunctionOf): Set<string> {
	const seen = new Set<string>();
	const take = (id: string): void => {
		if (seen.has(id)) return;
		seen.add(id);
		const fn = functionOf(id);
		for (const called of fn ? callsOf(fn) : []) take(called);
	};
	const pointer = pointerOf(automation);
	if (pointer) take(pointer.function);
	return seen;
}

/** A function's steps as written, each call naming what `to` answers. */
export const recalled = (fn: { steps: Sealed<FunctionStep> }, to: (id: string) => string): FunctionStep[] => {
	const each = (steps: readonly FunctionStep[]): FunctionStep[] =>
		steps.map((step): FunctionStep => {
			if (step.kind === "call") return { ...step, function: to(step.function) };
			if (step.kind === "try") return { ...step, steps: each(step.steps), catch: each(step.catch) };
			if (step.kind === "parallel" || step.kind === "start") return { ...step, steps: each(step.steps) };
			if (step.kind !== "if") return step;
			return {
				...step,
				...(step.steps ? { steps: each(step.steps) } : {}),
				...(step.else ? { else: each(step.else) } : {}),
			};
		});
	return each(open(fn.steps));
};

export const pointerOf = (automation: Walked): RunFunction | null =>
	open(automation.actions).find((action): action is RunFunction => action.kind === "run_function") ?? null;

/** One level; never through a call. */
export function written(body: Walked): readonly AutomationAction[];
export function written(fn: { steps: Sealed<FunctionStep> }): readonly FunctionStep[];
export function written(
	body: Walked | { steps: Sealed<FunctionStep> },
): readonly AutomationAction[] | readonly FunctionStep[] {
	return "actions" in body ? open(body.actions) : open(body.steps);
}
