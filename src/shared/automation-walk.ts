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

/** Called function step, at any depth. */
export interface WalkStep<K extends StepKind = StepKind> {
	reach: "step";
	path: string;
	/** Its call's path. */
	site: string;
	/** In its own list. */
	index: number;
	/** In its function's body. */
	address: Address;
	step: Extract<FunctionStep, { kind: K }>;
	via: string;
}

/** Unexpanded, not held, already above it, or past the walk's bound. */
export type Unfollowed = "not-expanded" | "missing" | "loop" | "budget";

/** Steps one walk answers before it follows no further call. */
export const WALK_ENTRIES_MAX = 256;
/** Functions one run may enter; a walk follows no call past it. */
export const RUN_FRAMES_MAX = 256;

export interface UnfollowedCall<R extends Unfollowed = Unfollowed> {
	reach: "unfollowedCall";
	path: string;
	call: RunFunction;
	reason: R;
}

export type WalkEntry = WalkAction | WalkStep | UnfollowedCall;
/** Walked without functions. */
export type FlatEntry = WalkAction | UnfollowedCall<"not-expanded">;
export type FollowedEntry = WalkAction | WalkStep | UnfollowedCall<"missing" | "loop" | "budget">;

/** Exhaustive walk handlers. */
export type WalkHandlers<E extends WalkEntry, R> = {
	[A in E["reach"]]: A extends "step"
		? { [K in StepKind]: (at: WalkStep<K>) => R }
		: (at: Extract<E, { reach: A }>) => R;
};

/** Kinds that steer or hold steps and act on nothing themselves. A new kind joins by hand. */
export const STEERING = [
	"if",
	"switch",
	"try",
	"parallel",
	"start",
	"await",
	"exit",
	"throw",
	"let",
	"wait",
	"note",
	"unparsed",
] as const satisfies readonly StepKind[];
type Steering = (typeof STEERING)[number];

/** One answer for every steering kind. */
export const steering = <R>(answer: (at: WalkStep<Steering>) => R): { [K in Steering]: (at: WalkStep<K>) => R } =>
	Object.fromEntries(STEERING.map((kind) => [kind, answer])) as { [K in Steering]: (at: WalkStep<K>) => R };

export function visit<E extends WalkEntry, R>(entry: E, handlers: WalkHandlers<E, R>): R {
	const at: WalkEntry = entry;
	const all = handlers as unknown as WalkHandlers<WalkEntry, R>;
	switch (at.reach) {
		case "action":
			return all.action(at);
		case "step":
			return (all.step[at.step.kind] as (held: WalkStep) => R)(at);
		case "unfollowedCall":
			return all.unfollowedCall(at);
	}
}

/** Null when not held. */
export type FunctionOf = (id: string) => AutomationFunction | null;

type Walked = { actions: Sealed<AutomationAction> };

/** Concurrent `parallel` and `start`. */
export const SIDES = ["then", "else", "try", "catch", "parallel", "start"] as const;
type Fixed = (typeof SIDES)[number];
/** Default follows case indexes. */
export type CaseSide = `case:${number}`;
export type Side = Fixed | CaseSide;

export const caseSide = (number: number): CaseSide => `case:${number}`;

const isCase = (side: Side): side is CaseSide => side.startsWith("case:");

/** Within one body: indexes and sides, ending on an index. */
export type Address = readonly (number | Side)[];

/** Side indexes identify branches. */
export const sideNumber = (side: Side): number => {
	if (isCase(side)) return Number(side.slice("case:".length));
	return side === "else" || side === "catch" ? 1 : 0;
};

export interface Branching<T> {
	kind: string;
	steps?: readonly T[];
	else?: readonly T[];
	catch?: readonly T[];
	cases?: readonly { steps?: readonly T[] }[];
	default?: readonly T[];
}

export interface TreeStep extends Branching<TreeStep> {}

export interface HeldSide<T> {
	side: Side;
	number: number;
	steps: readonly T[];
}

/** Switch map includes default. */
const SIDES_BY_KIND: { readonly [K in StepKind]: readonly Fixed[] | "cases" } = {
	if: ["then", "else"],
	switch: "cases",
	try: ["try", "catch"],
	parallel: ["parallel"],
	start: ["start"],
	do: [],
	await: [],
	exit: [],
	throw: [],
	let: [],
	wait: [],
	note: [],
	unparsed: [],
	call: [],
};

const fieldOf = (side: Fixed): "steps" | "else" | "catch" => {
	switch (side) {
		case "then":
		case "try":
		case "parallel":
		case "start":
			return "steps";
		case "else":
			return "else";
		case "catch":
			return "catch";
	}
};

const sidesNamed = <T>(step: Branching<T>): readonly Side[] => {
	const named = Object.hasOwn(SIDES_BY_KIND, step.kind) ? SIDES_BY_KIND[step.kind as StepKind] : [];
	if (named !== "cases") return named;
	return Array.from({ length: (step.cases?.length ?? 0) + 1 }, (_, at) => caseSide(at));
};

const listOf = <T>(step: Branching<T>, side: Side): readonly T[] | undefined => {
	if (!isCase(side)) return step[fieldOf(side)];
	const number = sideNumber(side);
	return number < (step.cases?.length ?? 0) ? step.cases?.[number]?.steps : step.default;
};

/** Sole step-list reader; see docs/fields.md. */
export const sidesOf = <T>(step: Branching<T>): HeldSide<T>[] =>
	sidesNamed(step).map((side) => ({ side, number: sideNumber(side), steps: listOf(step, side) ?? [] }));

/** Empty lists stay absent. */
export const withSides = (step: FunctionStep, lists: readonly (readonly FunctionStep[])[]): FunctionStep => {
	if (step.kind === "switch") {
		const { default: fallback, ...rest } = step;
		const cases = step.cases.map((held, at) => ({ ...held, steps: [...(lists[at] ?? [])] }));
		const last = lists[step.cases.length] ?? [];
		return { ...rest, cases, ...(fallback !== undefined || last.length > 0 ? { default: [...last] } : {}) };
	}
	const sides = sidesNamed(step);
	if (sides.length === 0) return step;
	const held: Branching<FunctionStep> = step;
	const written: Partial<Record<"steps" | "else" | "catch", readonly FunctionStep[]>> = {};
	sides.forEach((side, at) => {
		if (isCase(side)) return;
		const field = fieldOf(side);
		const list = lists[at] ?? [];
		if (held[field] !== undefined || list.length > 0) written[field] = list;
	});
	return { ...step, ...written } as FunctionStep;
};

/** Numbers alone: a call, an index and a side each read as one. */
export const STEP_PATH_RE = /^\d+(\.\d+)*$/;

const numbered = (address: Address): number[] =>
	address.map((segment) => (typeof segment === "number" ? segment : sideNumber(segment)));

/** A step of the body the call at `site` runs. */
export const within = (site: string, address: Address): string => [site, ...numbered(address)].join(".");

/** The call a step runs under: the longest of `sites` above it. */
export const siteAmong = (path: string, sites: Iterable<string>): string | null => {
	let found: string | null = null;
	for (const site of sites) {
		if (path.startsWith(`${site}.`) && (found === null || site.length > found.length)) found = site;
	}
	return found;
};

/** Its numbers below `site`; the body they address names the sides. */
export const below = (path: string, site: string): number[] =>
	path
		.slice(site.length + 1)
		.split(".")
		.map(Number);

/** Written order: a step before what it holds. */
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
	const budget = { left: WALK_ENTRIES_MAX, frames: RUN_FRAMES_MAX };
	return open(automation.actions).flatMap((action, at): WalkEntry[] => {
		const path = String(at);
		if (action.kind !== "run_function") return [{ reach: "action", path, index: at, action }];
		if (!functionOf) return [{ reach: "unfollowedCall", path, call: action, reason: "not-expanded" }];
		return followed(action, path, [], functionOf, budget);
	});
}

/** Steps under the call's path. */
function followed(
	call: RunFunction,
	site: string,
	chain: readonly string[],
	functionOf: FunctionOf,
	budget: { left: number; frames: number },
): WalkEntry[] {
	const unfollowed = (reason: "missing" | "loop" | "budget"): WalkEntry[] => [
		{ reach: "unfollowedCall", path: site, call, reason },
	];
	if (chain.includes(call.function)) return unfollowed("loop");
	const fn = functionOf(call.function);
	if (!fn) return unfollowed("missing");
	const steps = stepsIn(open(fn.steps), []);
	if (steps.length > budget.left || budget.frames === 0) return unfollowed("budget");
	budget.left -= steps.length;
	budget.frames -= 1;
	const above = [...chain, call.function];
	return steps.flatMap(({ address, step }): WalkEntry[] => {
		const path = within(site, address);
		const here: WalkStep = {
			reach: "step",
			path,
			site,
			index: address.at(-1) as number,
			address,
			step,
			via: call.function,
		};
		if (step.kind !== "call") return [here];
		const inner: RunFunction = { kind: "run_function", function: step.function };
		return [here, ...followed(inner, path, above, functionOf, budget)];
	});
}

/** Every step at every depth, a step before what it holds. */
function stepsIn(steps: readonly FunctionStep[], base: Address): { address: Address; step: FunctionStep }[] {
	return steps.flatMap((step, index) => {
		const address = [...base, index];
		return [{ address, step }, ...sidesOf(step).flatMap((held) => stepsIn(held.steps, [...address, held.side]))];
	});
}

/** A function's steps at every depth, each with its numbers under the function. */
export const stepsOf = (fn: {
	steps: Sealed<FunctionStep>;
}): { path: string; address: Address; step: FunctionStep }[] =>
	stepsIn(open(fn.steps), []).map(({ address, step }) => ({ path: numbered(address).join("."), address, step }));

interface Width {
	peak: number;
	rest: number;
}

const listWidth = (steps: readonly FunctionStep[]): Width => {
	let running = 0;
	let peak = 0;
	for (const step of steps) {
		const each = stepWidth(step);
		peak = Math.max(peak, running + each.peak);
		running += each.rest;
	}
	return { peak, rest: running };
};

const widest = (...lists: readonly (readonly FunctionStep[])[]): Width => {
	const widths = lists.map(listWidth);
	return { peak: Math.max(1, ...widths.map((w) => w.peak)), rest: Math.max(0, ...widths.map((w) => w.rest)) };
};

function stepWidth(step: FunctionStep): Width {
	const lists = sidesOf(step).map((held) => held.steps);
	const [first = [], second = []] = lists;
	switch (step.kind) {
		// Block waits for its branches.
		case "parallel":
			return {
				peak: Math.max(
					1,
					first.reduce((sum, each) => sum + listWidth([each]).peak, 0),
				),
				rest: 0,
			};
		// Task runs beside the cursor.
		case "start": {
			const task = listWidth(first).peak;
			return { peak: task + 1, rest: task };
		}
		// A catch runs while what the try started still runs.
		case "try": {
			const body = listWidth(first);
			const handler = listWidth(second);
			return { peak: Math.max(1, body.peak, body.rest + handler.peak), rest: body.rest + handler.rest };
		}
		default:
			return widest(...lists);
	}
}

export const widthOf = (steps: readonly FunctionStep[]): number => Math.max(1, listWidth(steps).peak);

/** A whole function's peak width. */
export const functionWidth = (fn: { steps: Sealed<FunctionStep> }): number => widthOf(open(fn.steps));

/** The functions a function's steps call, at any depth. */
export const callsOf = (fn: { steps: Sealed<FunctionStep> }): string[] =>
	stepsOf(fn).flatMap(({ step }) => (step.kind === "call" ? [step.function] : []));

/** Every function a run can enter. */
export function reachOf(automation: Walked, functionOf: FunctionOf): Set<string> {
	const seen = new Set<string>();
	const take = (id: string): void => {
		if (seen.has(id)) return;
		seen.add(id);
		const fn = functionOf(id);
		for (const called of fn ? callsOf(fn) : []) take(called);
	};
	const pointer = pointerOf(automation);
	if (pointer) take(pointer.function);
	return seen;
}

/** A function's steps as written, each call naming what `to` answers. */
export const recalled = (fn: { steps: Sealed<FunctionStep> }, to: (id: string) => string): FunctionStep[] => {
	const each = (steps: readonly FunctionStep[]): FunctionStep[] =>
		steps.map(
			(step): FunctionStep =>
				step.kind === "call"
					? { ...step, function: to(step.function) }
					: withSides(
							step,
							sidesOf(step).map((held) => each(held.steps)),
						),
		);
	return each(open(fn.steps));
};

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
