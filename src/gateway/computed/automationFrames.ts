// How a frame moves through a body's tree.

import type { Address, Side } from "../../shared/automation-walk.js";

export const FAILURE_CODES = [
	"refused",
	"unreachable",
	"no_answer",
	"unread",
	"timeout",
	"thrown",
	"call_failed",
	"loop",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface Failure {
	code: FailureCode;
	message: string;
}

export type { Address, Side } from "../../shared/automation-walk.js";

/** What the walk reads of a step. `steps` is an if's first side and a try's guarded one. */
export interface TreeStep {
	kind: string;
	steps?: readonly TreeStep[];
	else?: readonly TreeStep[];
	catch?: readonly TreeStep[];
}

const sideOf = (step: TreeStep, side: Side): readonly TreeStep[] | undefined => {
	switch (side) {
		case "then":
		case "try":
			return step.steps;
		case "else":
			return step.else;
		case "catch":
			return step.catch;
	}
};

/** A step's lists, first then second. */
const SIDES_OF: Readonly<Record<string, readonly [Side, Side]>> = { if: ["then", "else"], try: ["try", "catch"] };

/** A path's numbers below its call, read against the body they address. Null where they name no step. */
export const addressIn = (body: readonly TreeStep[], numbers: readonly number[]): Address | null => {
	const address: (number | Side)[] = [];
	let list: readonly TreeStep[] | undefined = body;
	for (let at = 0; at < numbers.length; at += 2) {
		const index = numbers[at] as number;
		const step: TreeStep | undefined = list?.[index];
		if (!step) return null;
		address.push(index);
		if (at + 1 === numbers.length) return address;
		const side: Side | undefined = Object.hasOwn(SIDES_OF, step.kind)
			? SIDES_OF[step.kind]?.[numbers[at + 1] as number]
			: undefined;
		if (!side) return null;
		address.push(side);
		list = sideOf(step, side);
	}
	return null;
};

/** `base` is empty or ends on a side. */
const listAt = (body: readonly TreeStep[], base: Address): readonly TreeStep[] | null => {
	let list: readonly TreeStep[] | undefined = body;
	let step: TreeStep | undefined;
	for (const segment of base) {
		if (list === undefined) return null;
		if (typeof segment === "number") step = list[segment];
		else list = step ? sideOf(step, segment) : undefined;
	}
	return list ?? null;
};

export const stepAt = (body: readonly TreeStep[], address: Address): TreeStep | null => {
	const index = address.at(-1);
	return typeof index === "number" ? (listAt(body, address.slice(0, -1))?.[index] ?? null) : null;
};

const first = (body: readonly TreeStep[], base: Address): Address | null =>
	(listAt(body, base)?.length ?? 0) > 0 ? [...base, 0] : null;

/** The next sibling, else what follows the owner of its side. */
const after = (body: readonly TreeStep[], address: Address): Address | null => {
	let at = address;
	for (;;) {
		const base = at.slice(0, -1);
		const index = at.at(-1) as number;
		if (index + 1 < (listAt(body, base)?.length ?? 0)) return [...base, index + 1];
		if (base.length === 0) return null;
		at = base.slice(0, -1);
	}
};

/** The `try` whose guarded side holds this step. A catch guards nothing. */
export const guardOf = (address: Address): Address | null => {
	const at = address.lastIndexOf("try");
	return at < 0 ? null : address.slice(0, at);
};

/** The `try` whose catch holds this step; `e` is its failure. */
export const catchOf = (address: Address): Address | null => {
	const at = address.lastIndexOf("catch");
	return at < 0 ? null : address.slice(0, at);
};

/** How the step whose turn it was ended. */
export type Ended =
	| { how: "done" }
	/** An `if` or a `try` leading into a side; null leads nowhere. */
	| { how: "took"; side: Side | null }
	| { how: "failed"; failure: Failure }
	| { how: "thrown"; failure: Failure }
	| { how: "exit" };

export type Move =
	/** `caught`: the catch entered, with its `try` and what it holds as `e`. */
	{ to: Address; caught?: { by: Address; failure: Failure } } | { end: "done" } | { end: "failed"; failure: Failure };

/** The first failure nothing caught. */
export interface FrameMemory {
	failed?: Failure;
}

const ended = (memory: FrameMemory): Move =>
	memory.failed ? { end: "failed", failure: memory.failed } : { end: "done" };

const onward = (body: readonly TreeStep[], from: Address, memory: FrameMemory): Move => {
	const to = after(body, from);
	return to ? { to } : ended(memory);
};

/** The first step, or an empty body's end. */
export const entered = (body: readonly TreeStep[]): Move => {
	const to = first(body, []);
	return to ? { to } : { end: "done" };
};

/** Where the frame goes once the step at `at` ended. */
export function moved(
	body: readonly TreeStep[],
	at: Address,
	how: Ended,
	memory: FrameMemory,
): { move: Move; memory: FrameMemory } {
	switch (how.how) {
		case "done":
			return { move: onward(body, at, memory), memory };
		case "took": {
			const to = how.side === null ? null : first(body, [...at, how.side]);
			return { move: to ? { to } : onward(body, at, memory), memory };
		}
		case "exit":
			return { move: ended(memory), memory };
		case "failed":
		case "thrown": {
			const guard = guardOf(at);
			if (guard) {
				const to = first(body, [...guard, "catch"]);
				const caught = { by: guard, failure: how.failure };
				// An empty catch still catches.
				return { move: to ? { to, caught } : onward(body, guard, memory), memory };
			}
			const noted = { failed: memory.failed ?? how.failure };
			if (how.how === "thrown") return { move: ended(noted), memory: noted };
			return { move: onward(body, at, noted), memory: noted };
		}
	}
}
