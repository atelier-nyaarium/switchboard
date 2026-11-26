// Which functions a home move carries with its automations.

import { callsOf, pointerOf } from "./automation-walk.js";
import type { CarriedAutomation, CarriedFunction } from "./schemasAutomation.js";

/** Listing order; unlisted stay behind. */
export function carriedFunctionsOf(
	automations: readonly CarriedAutomation[],
	listed: readonly CarriedFunction[],
): CarriedFunction[] {
	const byId = new Map(listed.map((fn) => [fn.id, fn]));
	const runs = new Set<string>();
	const take = (id: string): void => {
		if (runs.has(id)) return;
		runs.add(id);
		const fn = byId.get(id);
		for (const called of fn ? callsOf(fn.function) : []) take(called);
	};
	for (const { automation } of automations) {
		const pointer = pointerOf(automation);
		if (pointer) take(pointer.function);
	}
	return listed.filter((fn) => runs.has(fn.id));
}
