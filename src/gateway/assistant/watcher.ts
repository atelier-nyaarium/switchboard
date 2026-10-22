// A watcher is plain code. Its source holds the only copy.

import { z } from "zod";

export const WATCHER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Per poll. A source pages past it. */
export const MAX_POLL_EVENTS = 500;
const MAX_FIELDS = 32;

export const WatcherEventSchema = z.strictObject({
	/** The source's own id, as its actions take it. */
	id: z.string().min(1).max(256),
	/** When the source last updated it. */
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
	/** The unread list as it stands, with the validator to send next. */
	z.strictObject({
		kind: z.literal("events"),
		events: z.array(WatcherEventSchema).max(MAX_POLL_EVENTS),
		cursor: z.string().max(4_096).nullable(),
		/** More unread than a poll reads. */
		capped: z.boolean(),
		nextPollMs: delay,
	}),
	/** Nothing changed since the validator; the last count stands. */
	z.strictObject({ kind: z.literal("unchanged"), nextPollMs: delay }),
	z.strictObject({ kind: z.literal("backoff"), retryMs: delay, reason: z.string().max(400) }),
	/** Polls no more until the lane starts again or is poked. */
	z.strictObject({ kind: z.literal("stopped"), reason: z.string().max(400) }),
]);

export type PollAnswer = z.infer<typeof PollAnswerSchema>;

export interface ListQuery {
	scope: "new" | "all";
	/** The agent's mark, for `new`. */
	since?: number;
	/** The previous page's `next`. */
	page?: string;
}

export interface ListPage {
	/** Newest first. */
	events: WatcherEvent[];
	/** This page again, with the read's state. */
	here: string;
	next?: string;
	/** Set on the last page of a `new` read: the mark it reached. */
	mark?: number;
}

export interface Watcher {
	readonly id: string;
	/** What a rule may test. */
	readonly fields?: readonly string[];
	/** The secret it needs, shown to the owner. */
	readonly secret?: string;
	/** Settles once `signal` aborts. */
	poll(cursor: string | null, signal: AbortSignal): Promise<PollAnswer>;
	/** One unread page. */
	list?(query: ListQuery, signal: AbortSignal): Promise<ListPage>;
}
