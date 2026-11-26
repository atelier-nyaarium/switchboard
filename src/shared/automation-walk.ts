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

/** Unexpanded or missing function. */
export type Unfollowed = "not-expanded" | "missing";

export interface UnfollowedCall<R extends Unfollowed = Unfollowed> {
	reach: "unfollowedCall";
	path: string;
	call: RunFunction;
	reason: R;
}

export type WalkEntry = WalkAction | WalkStep | UnfollowedCall;
/** Walked without functions. */
export type FlatEntry = WalkAction | UnfollowedCall<"not-expanded">;
export type FollowedEntry = WalkAction | WalkStep | UnfollowedCall<"missing">;

/** Exhaustive walk handlers. */
export type WalkHandlers<E extends WalkEntry, R> = {
	[A in E["reach"]]: A extends "step"
		? { [K in StepKind]: (at: WalkStep<K>) => R }
		: (at: Extract<E, { reach: A }>) => R;
};

/** Kinds that steer or hold steps and act on nothing themselves. A new kind joins by hand. */
export const STEERING = ["if", "try", "exit", "throw", "let", "wait", "note"] as const satisfies readonly StepKind[];
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

/** A list a step holds, in written order. */
export const SIDES = ["then", "else", "try", "catch"] as const;
export type Side = (typeof SIDES)[number];

/** Within one body: indexes and sides, ending on an index. */
export type Address = readonly (number | Side)[];

/** A step's first list is 0, its second 1. */
export const sideNumber = (side: Side): 0 | 1 => (side === "then" || side === "try" ? 0 : 1);

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
	return open(automation.actions).flatMap((action, at): WalkEntry[] => {
		const path = String(at);
		if (action.kind !== "run_function") return [{ reach: "action", path, index: at, action }];
		if (!functionOf) return [{ reach: "unfollowedCall", path, call: action, reason: "not-expanded" }];
		const fn = functionOf(action.function);
		if (!fn) return [{ reach: "unfollowedCall", path, call: action, reason: "missing" }];
		return stepsIn(open(fn.steps), []).map(({ address, step }) => ({
			reach: "step",
			path: within(path, address),
			site: path,
			index: address.at(-1) as number,
			address,
			step,
			via: action.function,
		}));
	});
}

/** Every step at every depth, a step before what it holds. */
function stepsIn(steps: readonly FunctionStep[], base: Address): { address: Address; step: FunctionStep }[] {
	return steps.flatMap((step, index) => {
		const address = [...base, index];
		const held = (side: Side, list: readonly FunctionStep[] | undefined) => stepsIn(list ?? [], [...address, side]);
		if (step.kind === "if") return [{ address, step }, ...held("then", step.steps), ...held("else", step.else)];
		if (step.kind === "try") return [{ address, step }, ...held("try", step.steps), ...held("catch", step.catch)];
		return [{ address, step }];
	});
}

/** A function's steps at every depth, each with its numbers under the function. */
export const stepsOf = (fn: { steps: Sealed<FunctionStep> }): { path: string; step: FunctionStep }[] =>
	stepsIn(open(fn.steps), []).map(({ address, step }) => ({ path: numbered(address).join("."), step }));

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
