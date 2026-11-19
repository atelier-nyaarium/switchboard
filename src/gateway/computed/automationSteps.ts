// One step's attempts and its end, decided from its nature and the words it heard.

import { z } from "zod";
import type { AutomationRun } from "./automationLog.js";

/** What one attempt answers. */
export const ATTEMPT_WORDS = ["done", "refused", "unreachable", "no_answer"] as const;
export type AttemptWord = (typeof ATTEMPT_WORDS)[number];
/** `timeout`: judged past its time after a restart. */
export const STEP_WORDS = [...ATTEMPT_WORDS, "timeout"] as const;
export type StepWord = (typeof STEP_WORDS)[number];

/** Decides the retry. */
export const NATURES = ["sets", "sends", "nudges"] as const;
export type Nature = (typeof NATURES)[number];

/** Each step's own, from its turn. */
export const KEEP_TRYING_MS = 10 * 60_000;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;
/** One device attempt's bound and the shortest gap. */
export const OVERDUE_MS = 15_000 + BACKOFF_MIN_MS;

/** The words each nature tries again. */
const RETRIED: Readonly<Record<Nature, ReadonlySet<AttemptWord>>> = {
	sets: new Set(["unreachable", "no_answer"]),
	sends: new Set(["unreachable"]),
	nudges: new Set(),
};

export const retries = (nature: Nature, word: AttemptWord): boolean => RETRIED[nature].has(word);

/** `ended`: closed by a build that kept no word. */
export const VERDICTS = ["done", "failed", "ended"] as const;

export const StepPathSchema = z.string().regex(/^\d+$/);

export const StepSchema = z.strictObject({
	/** Begun; a hold is taken back off. */
	attempts: z.number().int().nonnegative(),
	/** Its turn came. */
	startedAt: z.number().int().optional(),
	/** The last attempt began, then answered. */
	lastAt: z.number().int().optional(),
	/** An attempt is out with no answer landed. */
	claimed: z.literal(true).optional(),
	/** The last word heard. */
	word: z.enum(STEP_WORDS).optional(),
	verdict: z.enum(VERDICTS).optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const FRESH_STEP: Step = { attempts: 0 };

export const isEnded = (step: Step): boolean => step.verdict !== undefined;

/** Clock back: window restarts, retry due. */
export const clamped = (found: Step, now: number): Step => {
	const { lastAt, ...step } = found;
	return {
		...step,
		...(step.startedAt !== undefined && step.startedAt > now ? { startedAt: now } : {}),
		...(lastAt !== undefined && lastAt <= now ? { lastAt } : {}),
	};
};

export const outOfTime = (step: Step, now: number): boolean =>
	step.startedAt !== undefined && now - Math.min(step.startedAt, now) >= KEEP_TRYING_MS;

export const backoffMs = (attempts: number): number =>
	Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempts - 1));

/** A last attempt ahead of the clock is due. */
export const attemptDue = (step: Step, now: number): boolean =>
	step.lastAt === undefined || step.lastAt > now || now >= step.lastAt + backoffMs(step.attempts);

/** A step due this long ago goes first. */
export const overdue = (step: Step, now: number): boolean => {
	const since = dueSince(step);
	return since !== null && since <= now && now - since > OVERDUE_MS;
};

/** Its last answer plus its gap, else its turn. */
export const dueSince = (step: Step): number | null =>
	step.lastAt !== undefined ? step.lastAt + backoffMs(step.attempts) : (step.startedAt ?? null);

const unclaimed = ({ claimed: _claimed, ...step }: Step): Step => step;

const ending = (step: Step, word: StepWord, verdict: "done" | "failed"): Step => ({
	...unclaimed(step),
	word,
	verdict,
});

/** The step's turn has come. */
export const begun = (step: Step, now: number): Step =>
	step.startedAt === undefined ? { ...step, startedAt: now } : step;

export const claimed = (step: Step, now: number): Step => ({
	...step,
	attempts: step.attempts + 1,
	lastAt: now,
	claimed: true,
});

/** Nothing sent; shortest gap. */
export const unsent = (step: Step, now: number): Step => ({
	...unclaimed(step),
	attempts: Math.max(0, step.attempts - 1),
	lastAt: now,
});

/** Backs off from the answer. */
export function heard(step: Step, nature: Nature, word: AttemptWord, now: number): Step {
	if (word === "done") return ending(step, word, "done");
	if (!retries(nature, word) || outOfTime(step, now)) return ending(step, word, "failed");
	return { ...unclaimed(step), word, lastAt: now };
}

/** Ends with its last word; only holds never got through. */
export const timedOut = (step: Step): Step => ending(step, step.word ?? "unreachable", "failed");

/** Unbegun steps are not judged. */
export function recovered(found: Step, nature: Nature | null, now: number): Step {
	const step = clamped(found, now);
	if (isEnded(step)) return step;
	if (step.claimed && nature !== "sets") return ending(step, "no_answer", "failed");
	if ((step.claimed || step.attempts > 0) && outOfTime(step, now)) return ending(step, "timeout", "failed");
	if (!step.claimed && step.attempts === 0) {
		// Only holds: its time starts again.
		const { startedAt: _startedAt, ...unbegun } = step;
		return unbegun;
	}
	if (!step.claimed) return step;
	// Interrupted, so tried again at once.
	const { lastAt: _lastAt, ...resumed } = unclaimed(step);
	return resumed;
}

/** A refusal before any attempt. */
export const refusedUnsent = (step: Step): Step => ending(step, "refused", "failed");

const WORD_REASONS: Readonly<Record<Exclude<StepWord, "done">, string>> = {
	refused: "it was refused",
	unreachable: "it could not be reached",
	no_answer: "no answer came back",
	timeout: "it ran out of time",
};

/** How an ended step logs. */
export function endRun(word: StepWord | undefined): { outcome: AutomationRun["outcome"]; reason?: string } {
	if (word === "done") return { outcome: "ran" };
	if (word === "no_answer") return { outcome: "uncertain", reason: WORD_REASONS.no_answer };
	return { outcome: "refused", reason: WORD_REASONS[word ?? "unreachable"] };
}
