// Which functions a home move carries with its automations.

import { reached, visit } from "./automation-walk.js";
import type { CarriedAutomation, CarriedFunction } from "./schemasAutomation.js";

/** Each function a carried automation runs, once, in listing order; one not listed stays behind. */
export function carriedFunctionsOf(
	automations: readonly CarriedAutomation[],
	listed: readonly CarriedFunction[],
): CarriedFunction[] {
	const runs = new Set(
		automations.flatMap(({ automation }) =>
			reached(automation).flatMap((at) =>
				visit(at, { action: () => [], unfollowedCall: ({ call }) => [call.function] }),
			),
		),
	);
	return listed.filter((fn) => runs.has(fn.id));
}
