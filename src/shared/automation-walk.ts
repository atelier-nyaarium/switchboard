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

/** As written. */
export interface ReachedAction {
	/** In a flat list, its index. */
	path: string;
	kind: AutomationAction["kind"];
	action: AutomationAction;
}

/** Reached through a pointer. */
export interface ReachedStep {
	/** Call path, then index. */
	path: string;
	kind: string;
	step: FunctionStep;
	via: string;
}

export type Reached = ReachedAction | ReachedStep;

/** Null when not held. */
export type FunctionOf = (id: string) => AutomationFunction | null;

type Walked = { actions: Sealed<AutomationAction> };

/** In written order; an unfollowable pointer is itself reached. */
export function reached(automation: Walked): ReachedAction[];
export function reached(automation: Walked, functionOf: FunctionOf): Reached[];
export function reached(automation: Walked, functionOf?: FunctionOf): Reached[] {
	return open(automation.actions).flatMap((action, at): Reached[] => {
		const path = String(at);
		const fn = action.kind === "run_function" ? functionOf?.(action.function) : null;
		if (!fn || action.kind !== "run_function") return [{ path, kind: action.kind, action }];
		return open(fn.steps).map((step, inner) => ({
			path: `${path}.${inner}`,
			kind: step.action,
			step,
			via: action.function,
		}));
	});
}

/** One level; never through a call. */
export function written(body: Walked): readonly AutomationAction[];
export function written(fn: { steps: Sealed<FunctionStep> }): readonly FunctionStep[];
export function written(
	body: Walked | { steps: Sealed<FunctionStep> },
): readonly AutomationAction[] | readonly FunctionStep[] {
	return "actions" in body ? open(body.actions) : open(body.steps);
}
