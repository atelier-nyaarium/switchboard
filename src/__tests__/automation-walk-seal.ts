// Read shapes the seal refuses; `bun run lint` fails if one compiles.

import { type FlatEntry, type FollowedEntry, visit } from "../shared/automation-walk.js";
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

export function visitSamples(flat: FlatEntry, followed: FollowedEntry): unknown[] {
	// @ts-expect-error a call left unhandled
	const noCall = visit(flat, { action: () => 1 });
	// @ts-expect-error steps left unhandled
	const noSteps = visit(followed, { action: () => 1, unfollowedFunction: () => 1 });
	// @ts-expect-error a step kind left unhandled
	const noKind = visit(followed, { action: () => 1, step: {}, unfollowedFunction: () => 1 });
	// @ts-expect-error an entry read unvisited
	const unvisited = followed.action;
	return [noCall, noSteps, noKind, unvisited];
}

export function stepSamples(fn: AutomationFunction): unknown[] {
	// @ts-expect-error a function's steps read directly
	const mapped = fn.steps.map((step) => step);
	// @ts-expect-error an index read
	const first = fn.steps[0];
	return [mapped, first];
}
