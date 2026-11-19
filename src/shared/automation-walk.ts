// The one walk over what an automation does.

import type { AutomationAction } from "./schemasAutomation.js";

export interface Reached {
	/** The step's path; in a flat list, its index. */
	path: string;
	action: AutomationAction;
}

/** Every action an automation reaches, in written order. */
export function reached(automation: { actions: readonly AutomationAction[] }): Reached[] {
	return automation.actions.map((action, at) => ({ path: String(at), action }));
}
