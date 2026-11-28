// A task is a `start` step's record: what reads it, what waits on it, what cannot.

import { JOIN_KEYS, storedOf, type Waited, waitedOf } from "../../shared/task-values.js";
import type { Failure } from "./automationFrames.js";
import { failureOf, isEnded, type Step } from "./automationSteps.js";

export { stored, TASK_KEY, waitedOf } from "../../shared/task-values.js";

export const NO_TASK = "it names no task of this run";
export const WAITS_FOREVER = "it would wait on itself";

type Steps = Readonly<Record<string, Step>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export interface TaskFacts {
	done: boolean;
	failed: boolean;
	error: Failure | null;
}

const RUNNING: TaskFacts = { done: false, failed: false, error: null };

/** How a task or a join stands now. */
export function factsOf(waited: Waited, steps: Steps): TaskFacts {
	if (typeof waited === "string") {
		const step = steps[waited];
		if (!step || !isEnded(step)) return RUNNING;
		const failed = step.verdict !== "done";
		return { done: true, failed, error: failed ? failureOf(step) : null };
	}
	if ("any" in waited)
		return { done: waited.any.some((item) => factsOf(item, steps).done), failed: false, error: null };
	const each = waited.all.map((item) => factsOf(item, steps));
	if (!each.every((facts) => facts.done)) return RUNNING;
	const errors = each.flatMap((facts) =>
		facts.error ? [{ code: facts.error.code, message: facts.error.message }] : [],
	);
	if (errors.length === 0) return { done: true, failed: false, error: null };
	return {
		done: true,
		failed: true,
		error: { code: "parallel", message: `${errors.length} of ${each.length} failed`, errors },
	};
}

const shownOf = (facts: TaskFacts): string => (facts.failed ? "failed" : facts.done ? "done" : "running");

/** A variable's value as a step reads it: every task in it with how it stands now. */
export function dressed(value: unknown, steps: Steps): unknown {
	const waited = waitedOf(value);
	if (waited !== null) {
		const inner = typeof waited === "string" ? storedOf(waited) : dressedJoin(waited, steps);
		return { ...inner, ...factsOf(waited, steps) };
	}
	if (Array.isArray(value)) return value.map((item) => dressed(item, steps));
	if (isRecord(value))
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dressed(item, steps)]));
	return value;
}

const dressedJoin = (waited: Exclude<Waited, string>, steps: Steps): Record<string, unknown> =>
	"all" in waited
		? { [JOIN_KEYS.all]: waited.all.map((item) => dressed(storedOf(item), steps)) }
		: { [JOIN_KEYS.any]: waited.any.map((item) => dressed(storedOf(item), steps)) };

/** A frame variable as a scope holds it; a task prints how it stands. */
export function taskName(value: unknown, steps: Steps): { value: unknown; shown?: string } {
	const waited = waitedOf(value);
	return waited === null
		? { value: dressed(value, steps) }
		: { value: dressed(value, steps), shown: shownOf(factsOf(waited, steps)) };
}

/** Every task a value names. */
export const tasksIn = (waited: Waited): string[] =>
	typeof waited === "string" ? [waited] : ("all" in waited ? waited.all : waited.any).flatMap(tasksIn);

/** The tasks an await takes as seen: all it waited on, but none under an `any`. */
const seenIn = (waited: Waited): string[] =>
	typeof waited === "string" ? [waited] : "all" in waited ? waited.all.flatMap(seenIn) : [];

export const nextEnded = (steps: Steps): number =>
	1 + Math.max(0, ...Object.values(steps).map((step) => step.ended ?? 0));

/** When it ended in the run's order, or null while it runs. */
function endedAt(waited: Waited, steps: Steps): number | null {
	if (typeof waited === "string") {
		const step = steps[waited];
		return step && isEnded(step) ? (step.ended ?? 0) : null;
	}
	const each = ("all" in waited ? waited.all : waited.any).map((item) => endedAt(item, steps));
	const ended = each.filter((at): at is number => at !== null);
	if ("all" in waited) return ended.length === each.length ? Math.max(...ended) : null;
	return ended.length > 0 ? Math.min(...ended) : null;
}

/** How an `await` ends now, or null while it waits. `seen`: the tasks it took. */
export function awaited(
	waited: Waited,
	steps: Steps,
): { failure: Failure | null; value: Record<string, unknown>; seen: string[] } | null {
	const facts = factsOf(waited, steps);
	if (!facts.done) return null;
	if (typeof waited === "string" || "all" in waited) {
		return { failure: facts.error, value: storedOf(waited), seen: seenIn(waited) };
	}
	// The first to end, though several ended before it asked.
	const first = waited.any.reduce((best, item) => {
		const at = endedAt(item, steps);
		const held = endedAt(best, steps);
		return at !== null && (held === null || at < held) ? item : best;
	});
	return { failure: null, value: storedOf(first), seen: [] };
}

/**
 * Whether an `await` at `at` waiting on `waited` could never end. What can end grows from the tasks
 * already ended and the ones with no open await beneath them; what never joins it waits forever.
 */
export function waitsForever(at: string, waited: Waited, steps: Steps): boolean {
	const awaits = new Map<string, Waited>();
	for (const [path, step] of Object.entries(steps)) if (!isEnded(step) && step.awaits) awaits.set(path, step.awaits);
	awaits.set(at, waited);
	const tasks = new Set([...awaits.values()].flatMap(tasksIn));
	const free = new Set<string>();
	const ends = (item: Waited): boolean =>
		typeof item === "string" ? free.has(item) : "all" in item ? item.all.every(ends) : item.any.some(ends);
	for (let grew = true; grew; ) {
		grew = false;
		for (const task of tasks) {
			if (free.has(task)) continue;
			const step = steps[task];
			const beneath = [...awaits.keys()].filter((path) => path.startsWith(`${task}.`));
			if ((step !== undefined && isEnded(step)) || beneath.every((path) => free.has(path))) {
				free.add(task);
				grew = true;
			}
		}
		for (const [path, item] of awaits) {
			if (!free.has(path) && ends(item)) {
				free.add(path);
				grew = true;
			}
		}
	}
	return !free.has(at);
}
