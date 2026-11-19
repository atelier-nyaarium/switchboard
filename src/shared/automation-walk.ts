// The one walk over what an automation does.

import type { z } from "zod";
import type { AutomationAction } from "./schemasAutomation.js";

declare const opened: unique symbol;

/** Opened only here. */
export interface Sealed<T> {
	readonly [opened]: readonly T[];
}

/** Codegen reads `walked`. */
export const walked = <T extends z.ZodType>(list: z.ZodArray<T>) =>
	list.transform((items) => items as unknown as Sealed<z.output<T>>).meta({ walked: true });

const open = <T>(list: Sealed<T>): readonly T[] => list as unknown as readonly T[];

export interface Reached {
	/** The step's path; in a flat list, its index. */
	path: string;
	action: AutomationAction;
}

/** Every action an automation reaches, in written order. */
export function reached(automation: { actions: Sealed<AutomationAction> }): Reached[] {
	return open(automation.actions).map((action, at) => ({ path: String(at), action }));
}

/** Syntax only; never walks calls. */
export function written(body: { actions: Sealed<AutomationAction> }): readonly AutomationAction[] {
	return open(body.actions);
}
