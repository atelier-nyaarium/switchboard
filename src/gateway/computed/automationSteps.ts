// One step's attempts and its end, decided from its nature and the words it heard.

import { z } from "zod";
import { KEEP_TRYING_MIN_DEFAULT } from "../../shared/schemasAutomation.js";
import type { RunRow } from "./automationLog.js";

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
export const KEEP_TRYING_MS = KEEP_TRYING_MIN_DEFAULT * 60_000;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;

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
	/** Window begun; unbegun erased on restart. */
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

/** A step whose window has begun. */
export type Begun = Step & { startedAt: number };

/** Its window's start, else its last answer plus its gap. */
export const dueAt = (step: Begun): number =>
	step.lastAt === undefined ? step.startedAt : step.lastAt + backoffMs(step.attempts);

const unclaimed = ({ claimed: _claimed, ...step }: Step): Step => step;

const ending = (step: Step, word: StepWord, verdict: "done" | "failed"): Step => ({
	...unclaimed(step),
	word,
	verdict,
});

/** The step's turn has come. */
export const begun = (step: Step, now: number): Begun =>
	step.startedAt === undefined ? { ...step, startedAt: now } : (step as Begun);

export const claimed = (step: Step, now: number): Step => ({
	...step,
	attempts: step.attempts + 1,
	lastAt: now,
	claimed: true,
});

/** Nothing sent; waits the gap its answers earned. */
export const unsent = (step: Step, now: number): Step => ({
	...unclaimed(step),
	attempts: Math.max(0, step.attempts - 1),
	lastAt: now,
});

/** Backs off from the answer; an unknown nature never retries. */
export function heard(step: Step, nature: Nature | null, word: AttemptWord, now: number): Step {
	if (word === "done") return ending(step, word, "done");
	if (nature === null || !retries(nature, word) || outOfTime(step, now)) return ending(step, word, "failed");
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
export function endedOutcome(word: StepWord | undefined): { outcome: RunRow["outcome"]; reason?: string } {
	if (word === "done") return { outcome: "ran" };
	if (word === "no_answer") return { outcome: "uncertain", reason: WORD_REASONS.no_answer };
	return { outcome: "refused", reason: WORD_REASONS[word ?? "unreachable"] };
}
