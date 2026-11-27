// One step's attempts and its end, decided from its nature and the words it heard.

import { z } from "zod";
import { STEP_PATH_RE } from "../../shared/automation-walk.js";
import { KEEP_TRYING_MIN_DEFAULT } from "../../shared/schemasAutomation.js";
import { FUNCTION_STEPS_TOTAL_MAX, RUN_STRANDS_MAX, SWITCH_CASES_MAX } from "../../shared/schemasFunction.js";
import type { Waited } from "../../shared/task-values.js";
import { FAILURE_CODES, FAILURE_MESSAGE_MAX, type Failure, type FailureCode } from "./automationFrames.js";
import type { LogRow } from "./automationLog.js";

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

/** The walk owns its spelling. */
export const StepPathSchema = z.string().regex(STEP_PATH_RE);

export type { Waited } from "../../shared/task-values.js";

const JOINED_MAX = FUNCTION_STEPS_TOTAL_MAX;
export const WaitedSchema: z.ZodType<Waited> = z.lazy(() =>
	z.union([
		StepPathSchema,
		z.strictObject({ all: z.array(WaitedSchema).min(1).max(JOINED_MAX) }),
		z.strictObject({ any: z.array(WaitedSchema).min(1).max(JOINED_MAX) }),
	]),
);

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
	/** Why it failed, where the word cannot say. */
	code: z.enum(FAILURE_CODES).optional(),
	/** That failure's sentence. */
	message: z.string().max(FAILURE_MESSAGE_MAX).optional(),
	/** First failure per branch. */
	errors: z
		.array(z.strictObject({ code: z.enum(FAILURE_CODES), message: z.string().max(FAILURE_MESSAGE_MAX) }))
		.max(RUN_STRANDS_MAX)
		.optional(),
	/** The side an `if` took. */
	side: z.enum(["then", "else"]).optional(),
	/** Taken case index. */
	case: z.number().int().nonnegative().max(SWITCH_CASES_MAX).optional(),
	/** When a `wait` ends. */
	until: z.number().int().optional(),
	awaits: WaitedSchema.optional(),
	seen: z.literal(true).optional(),
	ended: z.number().int().positive().optional(),
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

export const outOfTime = (step: Step, now: number, windowMs = KEEP_TRYING_MS): boolean =>
	step.startedAt !== undefined && now - Math.min(step.startedAt, now) >= windowMs;

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
export function heard(step: Step, nature: Nature | null, word: AttemptWord, now: number, windowMs?: number): Step {
	if (word === "done") return ending(step, word, "done");
	if (nature === null || !retries(nature, word) || outOfTime(step, now, windowMs))
		return ending(step, word, "failed");
	return { ...unclaimed(step), word, lastAt: now };
}

/** Ends with its last word; only holds never got through. */
export const timedOut = (step: Step): Step => ending(step, step.word ?? "unreachable", "failed");

export const expired = (step: Step): Step => ending(step, "timeout", "failed");

/** Unbegun steps are not judged. */
export function recovered(found: Step, nature: Nature | null, now: number, windowMs?: number): Step {
	const step = clamped(found, now);
	if (isEnded(step)) return step;
	if (step.claimed && nature !== "sets") return ending(step, "no_answer", "failed");
	if ((step.claimed || step.attempts > 0) && outOfTime(step, now, windowMs)) return ending(step, "timeout", "failed");
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

/** A failed step keeps the reason it was given. */
export const saying = (step: Step, reason: string | undefined): Step =>
	reason === undefined || step.verdict !== "failed" || step.message !== undefined
		? step
		: { ...step, message: reason.slice(0, FAILURE_MESSAGE_MAX) };

const WORD_REASONS: Readonly<Record<Exclude<StepWord, "done">, string>> = {
	refused: "it was refused",
	unreachable: "it could not be reached",
	no_answer: "no answer came back",
	timeout: "it ran out of time",
};

/** What a failed step's frame is told. */
export const failureOf = (step: Step): Failure => {
	const word = step.word === undefined || step.word === "done" ? "unreachable" : step.word;
	return {
		code: step.code ?? word,
		message: step.message ?? WORD_REASONS[word],
		...(step.errors ? { errors: step.errors } : {}),
	};
};

/** Ends failed for a reason no attempt gave. */
export const failedAs = (step: Step, code: FailureCode, message: string, errors?: readonly Failure[]): Step => ({
	...ending(step, "refused", "failed"),
	code,
	message: message.slice(0, FAILURE_MESSAGE_MAX),
	// Failure lists stay flat.
	...(errors && errors.length > 0
		? {
				errors: errors
					.slice(0, RUN_STRANDS_MAX)
					.map(({ code: held, message: said }) => ({ code: held, message: said })),
			}
		: {}),
});

/** Switch case index. */
export const steered = (step: Step, taken?: "then" | "else" | number): Step => ({
	...ending(step, "done", "done"),
	...(typeof taken === "number" ? { case: taken } : taken ? { side: taken } : {}),
});

/** How an ended step logs. */
export function endedOutcome(word: StepWord | undefined): { outcome: LogRow["outcome"]; reason?: string } {
	if (word === "done") return { outcome: "ran" };
	if (word === "no_answer") return { outcome: "uncertain", reason: WORD_REASONS.no_answer };
	return { outcome: "refused", reason: WORD_REASONS[word ?? "unreachable"] };
}
