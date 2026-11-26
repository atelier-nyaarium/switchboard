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

/** Called function step. */
export interface WalkStep<K extends StepKind = StepKind> {
	reach: "step";
	/** Call path, then index. */
	path: string;
	index: number;
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

export function visit<E extends WalkEntry, R>(entry: E, handlers: WalkHandlers<E, R>): R {
	const at: WalkEntry = entry;
	const all = handlers as unknown as WalkHandlers<WalkEntry, R>;
	switch (at.reach) {
		case "action":
			return all.action(at);
		case "step":
			return all.step[at.step.kind](at);
		case "unfollowedCall":
			return all.unfollowedCall(at);
	}
}

/** Null when not held. */
export type FunctionOf = (id: string) => AutomationFunction | null;

type Walked = { actions: Sealed<AutomationAction> };

const under = (site: string, index: number): string => `${site}.${index}`;

/** Call path or null. */
export const siteOf = (path: string): string | null => {
	const at = path.lastIndexOf(".");
	return at < 0 ? null : path.slice(0, at);
};

/** Written order. */
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
		return open(fn.steps).map((step, inner) => ({
			reach: "step",
			path: under(path, inner),
			index: inner,
			step,
			via: action.function,
		}));
	});
}

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
