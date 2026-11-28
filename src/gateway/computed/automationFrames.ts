// How a frame moves through a body's tree.

import { type Address, type HeldSide, type Side, sidesOf, type TreeStep } from "../../shared/automation-walk.js";

export const FAILURE_CODES = [
	"refused",
	"unreachable",
	"no_answer",
	"unread",
	"timeout",
	"thrown",
	"function_failed",
	"loop",
	"parallel",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const FAILURE_MESSAGE_MAX = 200;

export interface Failure {
	code: FailureCode;
	message: string;
	/** First failure per branch. */
	errors?: { code: FailureCode; message: string }[];
}

export type { Address, Side, TreeStep } from "../../shared/automation-walk.js";

const sideOf = (step: TreeStep, side: Side): readonly TreeStep[] | undefined =>
	sidesOf(step).find((held) => held.side === side)?.steps;

/** Innermost branch index. */
const branchAt = (address: Address): number => Math.max(address.lastIndexOf("parallel"), address.lastIndexOf("start"));

/** Branch owner address. */
export const ownerOf = (address: Address): Address | null => {
	const at = branchAt(address);
	return at < 0 ? null : address.slice(0, at);
};

/** Branch memory key. */
export const branchOf = (address: Address): Address | null => {
	const at = branchAt(address);
	if (at < 0) return null;
	return address[at] === "parallel" ? address.slice(0, at + 2) : address.slice(0, at);
};

/** One-step block branches. */
export const branchesOf = (body: readonly TreeStep[], at: Address): Address[] =>
	(listAt(body, [...at, "parallel"]) ?? []).map((_, index) => [...at, "parallel", index]);

/** Task entry, if present. */
export const taskOf = (body: readonly TreeStep[], at: Address): Address | null => first(body, [...at, "start"]);

/** A path's numbers below the step that runs it, read against the body they address. Null where they name no step. */
export const addressIn = (body: readonly TreeStep[], numbers: readonly number[]): Address | null => {
	const address: (number | Side)[] = [];
	let list: readonly TreeStep[] | undefined = body;
	for (let at = 0; at < numbers.length; at += 2) {
		const index = numbers[at] as number;
		const step: TreeStep | undefined = list?.[index];
		if (!step) return null;
		address.push(index);
		if (at + 1 === numbers.length) return address;
		const held: HeldSide<TreeStep> | undefined = sidesOf(step)[numbers[at + 1] as number];
		if (!held) return null;
		address.push(held.side);
		list = held.steps;
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

export const stepAt = <T extends TreeStep>(body: readonly T[], address: Address): T | null => {
	const index = address.at(-1);
	return typeof index === "number" ? ((listAt(body, address.slice(0, -1))?.[index] as T | undefined) ?? null) : null;
};

const first = (body: readonly TreeStep[], base: Address): Address | null =>
	(listAt(body, base)?.length ?? 0) > 0 ? [...base, 0] : null;

/** Next or branch end. */
const after = (body: readonly TreeStep[], address: Address): Address | "ran" | null => {
	let at = address;
	for (;;) {
		const base = at.slice(0, -1);
		const index = at.at(-1) as number;
		const side = base.at(-1);
		// Branches contain one step.
		if (side !== "parallel" && index + 1 < (listAt(body, base)?.length ?? 0)) return [...base, index + 1];
		if (base.length === 0) return null;
		if (side === "parallel" || side === "start") return "ran";
		at = base.slice(0, -1);
	}
};

/** Branch-local try guard. */
export const guardOf = (address: Address): Address | null => {
	const at = address.lastIndexOf("try");
	return at < 0 || at < branchAt(address) ? null : address.slice(0, at);
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
	| { how: "return" };

export type Move =
	/** `caught`: the catch entered, with its `try` and what it holds as `e`. */
	| { to: Address; caught?: { by: Address; failure: Failure } }
	| { end: "done" }
	| { end: "failed"; failure: Failure }
	/** Branch completion and owner. */
	| { branch: Address; failure?: Failure };

/** Uncaught failure. */
export interface FrameMemory {
	failed?: Failure;
}

/** Owner closes branch. */
const ended = (at: Address, memory: FrameMemory): Move => {
	const owner = ownerOf(at);
	if (owner) return { branch: owner, ...(memory.failed ? { failure: memory.failed } : {}) };
	return memory.failed ? { end: "failed", failure: memory.failed } : { end: "done" };
};

const onward = (body: readonly TreeStep[], from: Address, memory: FrameMemory): Move => {
	const to = after(body, from);
	return to === null || to === "ran" ? ended(from, memory) : { to };
};

/** The first step, or an empty body's end. */
export const entered = (body: readonly TreeStep[]): Move => {
	const to = first(body, []);
	return to ? { to } : { end: "done" };
};

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
		case "return":
			return { move: ended(at, memory), memory };
		case "failed":
		case "thrown": {
			const guard = guardOf(at);
			if (guard) {
				const to = first(body, [...guard, "catch"]);
				const caught = { by: guard, failure: how.failure };
				// An empty catch still catches.
				return { move: to ? { to, caught } : onward(body, guard, memory), memory };
			}
			const remembered = { failed: memory.failed ?? how.failure };
			if (how.how === "thrown") return { move: ended(at, remembered), memory: remembered };
			return { move: onward(body, at, remembered), memory: remembered };
		}
	}
}
