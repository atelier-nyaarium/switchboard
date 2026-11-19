// Which functions a home move carries with its automations.

import { reached } from "./automation-walk.js";
import type { CarriedAutomation, CarriedFunction } from "./schemasAutomation.js";

/** Each function a carried automation runs, once, in listing order; one not listed stays behind. */
export function carriedFunctionsOf(
	automations: readonly CarriedAutomation[],
	listed: readonly CarriedFunction[],
): CarriedFunction[] {
	const runs = new Set(
		automations.flatMap(({ automation }) =>
			reached(automation).flatMap(({ action }) => (action.kind === "run_function" ? [action.function] : [])),
		),
	);
	return listed.filter((fn) => runs.has(fn.id));
}
