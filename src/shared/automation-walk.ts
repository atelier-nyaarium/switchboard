// The one walk over what an automation does.

import type { AutomationAction } from "./schemasAutomation.js";

export interface Reached {
	/** The engine's step path. */
	path: string;
	action: AutomationAction;
}

/** Every action an automation reaches, in written order. */
export function reached(automation: { actions: readonly AutomationAction[] }): Reached[] {
	return automation.actions.map((action, at) => ({ path: String(at), action }));
}
