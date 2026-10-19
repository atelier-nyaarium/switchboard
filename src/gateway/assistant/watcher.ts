// A watcher is plain code, never a model.

import { z } from "zod";

export const WATCHER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Per poll. A source pages past it. */
export const MAX_POLL_EVENTS = 500;
const MAX_FIELDS = 32;

export const WatcherEventSchema = z.strictObject({
	/** Stable across polls, so a replay dedupes. */
	sourceId: z.string().min(1).max(256),
	/** When the source says it happened. */
	at: z.number().int().nonnegative(),
	title: z.string().max(1_000),
	/** Rule match fields, by name. */
	fields: z
		.record(z.string().max(64), z.string().max(1_000))
		.refine((fields) => Object.keys(fields).length <= MAX_FIELDS, `at most ${MAX_FIELDS} fields`),
	url: z.string().max(2_000).optional(),
});

export type WatcherEvent = z.infer<typeof WatcherEventSchema>;

const delay = z
	.number()
	.int()
	.nonnegative()
	.max(7 * 24 * 60 * 60 * 1000);

export const PollAnswerSchema = z.discriminatedUnion("kind", [
	/** The cursor lands with the events, in one write. */
	z.strictObject({
		kind: z.literal("events"),
		events: z.array(WatcherEventSchema).max(MAX_POLL_EVENTS),
		cursor: z.string().max(4_096).nullable(),
		nextPollMs: delay,
	}),
	z.strictObject({ kind: z.literal("backoff"), retryMs: delay, reason: z.string().max(400) }),
	/** Polls no more until the runner starts again. */
	z.strictObject({ kind: z.literal("stopped"), reason: z.string().max(400) }),
]);

export type PollAnswer = z.infer<typeof PollAnswerSchema>;

export interface Watcher {
	readonly id: string;
	/** What a rule may test. */
	readonly fields?: readonly string[];
	/** Ping when no rule says. */
	readonly pingDefault?: boolean;
	/** The secret it needs, shown to the owner. */
	readonly secret?: string;
	/** `signal` aborts when the runner gives up on this poll; the poll settles then. */
	poll(cursor: string | null, signal: AbortSignal): Promise<PollAnswer>;
}
