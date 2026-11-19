// Read shapes the seal refuses; `bun run lint` fails if one compiles.

import type { Automation } from "../shared/schemasAutomation.js";
import type { AutomationFunction } from "../shared/schemasFunction.js";

export function sealSamples(automation: Automation, rows: Automation[]): unknown[] {
	// @ts-expect-error a member read
	const mapped = automation.actions.map((action) => action);
	// @ts-expect-error an index read
	const first = automation.actions[0];
	// @ts-expect-error a destructured element
	const [head] = automation.actions;
	// @ts-expect-error a spread
	const spread = [...automation.actions];
	const looped: unknown[] = [];
	// @ts-expect-error a for-of
	for (const action of automation.actions) looped.push(action);
	const destructured = rows.map(
		// @ts-expect-error a destructured parameter
		({ actions }: Automation) => actions.length,
	);
	// @ts-expect-error a length read
	const count: number = automation.actions.length;
	return [mapped, first, head, spread, looped, destructured, count];
}

export function stepSamples(fn: AutomationFunction): unknown[] {
	// @ts-expect-error a function's steps read directly
	const mapped = fn.steps.map((step) => step);
	// @ts-expect-error an index read
	const first = fn.steps[0];
	return [mapped, first];
}
