// The assistant's inbox: every watcher's events, cursor, health and read position, in one snapshot.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import { type PollAnswer, type WatcherEvent, WatcherEventSchema } from "./watcher.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Unread rows past this, per watcher, evict oldest first. */
export const INBOX_CAP = 500;
export const INBOX_RETENTION_MS = 14 * DAY_MS;
/** Long enough for a rule edit to replay a drop. */
export const DROP_RETENTION_MS = 7 * DAY_MS;
/** Outlives every row, so a late replay cannot resurrect one. */
export const SEEN_RETENTION_MS = 30 * DAY_MS;

const DispositionSchema = z.enum(["inbox", "woken", "ruleDropped"]);

export type Disposition = z.infer<typeof DispositionSchema>;

const InboxEventSchema = WatcherEventSchema.extend({
	watcherId: z.string(),
	/** Delivery order, fresh whenever the event becomes eligible again. */
	seq: z.number().int().positive(),
	receivedAt: z.number().int().nonnegative(),
	disposition: DispositionSchema,
});

export type InboxEvent = z.infer<typeof InboxEventSchema>;

const WatcherStateSchema = z.strictObject({
	cursor: z.string().nullable(),
	/** The highest seq a reader confirmed. */
	readSeq: z.number().int().nonnegative(),
	lastSuccessAt: z.number().optional(),
	nextPollAt: z.number().optional(),
	backoff: z.strictObject({ until: z.number(), reason: z.string() }).optional(),
	stopped: z.string().optional(),
	/** Unread rows lost to the cap or the retention window. */
	evicted: z.number().int().nonnegative(),
});

export type WatcherState = z.infer<typeof WatcherStateSchema>;

const SnapshotSchema = z.strictObject({
	v: z.literal(1),
	nextSeq: z.number().int().positive(),
	events: z.array(InboxEventSchema),
	watchers: z.record(z.string(), WatcherStateSchema),
	/** Per watcher: source id to first seen. */
	seen: z.record(z.string(), z.record(z.string(), z.number())),
});

type Snapshot = z.infer<typeof SnapshotSchema>;

const EMPTY: Snapshot = { v: 1, nextSeq: 1, events: [], watchers: {}, seen: {} };

/** A source id is the source's own string, so `constructor` or `__proto__` must stay plain keys. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function put<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

function freshWatcher(): WatcherState {
	return { cursor: null, readSeq: 0, evicted: 0 };
}

/** Health after a poll's answer. The cursor moves only with events. */
function healthAfter(held: WatcherState, answer: PollAnswer, now: number): WatcherState {
	const { backoff: _backoff, stopped: _stopped, nextPollAt: _next, ...kept } = held;
	if (answer.kind === "events") {
		return { ...kept, cursor: answer.cursor, lastSuccessAt: now, nextPollAt: now + answer.nextPollMs };
	}
	if (answer.kind === "backoff") {
		const until = now + answer.retryMs;
		return { ...kept, backoff: { until, reason: answer.reason }, nextPollAt: until };
	}
	return { ...kept, stopped: answer.reason };
}

function kept(event: InboxEvent, now: number): boolean {
	const window = event.disposition === "ruleDropped" ? DROP_RETENTION_MS : INBOX_RETENTION_MS;
	return event.receivedAt >= now - window;
}

/** Retention and the cap. An unread inbox row lost either way is counted against its watcher. */
function trimmed(snapshot: Snapshot, now: number): Snapshot {
	const evicted = new Map<string, number>();
	const readOf = (watcherId: string) => own(snapshot.watchers, watcherId)?.readSeq ?? 0;
	const lose = (event: InboxEvent) => {
		const read = readOf(event.watcherId);
		if (event.disposition === "inbox" && event.seq > read) {
			evicted.set(event.watcherId, (evicted.get(event.watcherId) ?? 0) + 1);
		}
	};
	const live: InboxEvent[] = [];
	for (const event of snapshot.events) {
		if (kept(event, now)) live.push(event);
		else lose(event);
	}
	// Seq order, so a re-sequenced row is the newest.
	live.sort((a, b) => a.seq - b.seq);
	const unread = new Map<string, InboxEvent[]>();
	for (const event of live) {
		if (event.disposition !== "inbox" || event.seq <= readOf(event.watcherId)) continue;
		unread.set(event.watcherId, [...(unread.get(event.watcherId) ?? []), event]);
	}
	const over = new Set<InboxEvent>();
	for (const rows of unread.values()) {
		for (const event of rows.slice(0, Math.max(0, rows.length - INBOX_CAP))) over.add(event);
	}
	for (const event of over) lose(event);
	const events = live.filter((event) => !over.has(event));
	const watchers = Object.fromEntries(
		Object.entries(snapshot.watchers).map(([id, state]) => [
			id,
			{ ...state, evicted: state.evicted + (evicted.get(id) ?? 0) },
		]),
	);
	const seen = Object.fromEntries(
		Object.entries(snapshot.seen).map(([id, ids]) => [
			id,
			Object.fromEntries(Object.entries(ids).filter(([, at]) => at >= now - SEEN_RETENTION_MS)),
		]),
	);
	return { ...snapshot, events, watchers, seen };
}

/** A restored seq never reuses one already handed out or confirmed. */
function repaired(snapshot: Snapshot): Snapshot {
	let used = 0;
	for (const event of snapshot.events) used = Math.max(used, event.seq);
	for (const state of Object.values(snapshot.watchers)) used = Math.max(used, state.readSeq);
	return { ...snapshot, nextSeq: Math.max(snapshot.nextSeq, used + 1) };
}

export interface InboxStore {
	/**
	 * A poll's events, cursor and health in one checked write, or null when it did not land: memory
	 * then keeps the old cursor, so the next poll asks again. A source id already seen is skipped,
	 * and `accepted` holds only the rows kept.
	 */
	commitPoll(
		watcherId: string,
		answer: PollAnswer,
		now: number,
		sort?: (event: WatcherEvent) => Disposition,
	): { accepted: InboxEvent[] } | null;
	stateOf(watcherId: string): WatcherState | undefined;
	events(watcherId?: string): InboxEvent[];
	/** Inbox rows past the watcher's read position. */
	unread(watcherId: string): number;
}

export function createInboxStore(store: DurableStore): InboxStore {
	const loaded = store.load();
	let state: Snapshot = loaded === null ? EMPTY : repaired(SnapshotSchema.parse(loaded));

	const commit = (next: Snapshot): boolean => {
		const previous = state;
		state = next;
		try {
			store.saveChecked(state);
			return true;
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) return true;
			state = previous;
			console.warn(`[assistant] inbox write failed: ${(error as Error).message}`);
			return false;
		}
	};

	return {
		commitPoll(watcherId, answer, now, sort = () => "inbox") {
			const held = own(state.watchers, watcherId) ?? freshWatcher();
			const seenHere = { ...(own(state.seen, watcherId) ?? {}) };
			let nextSeq = state.nextSeq;
			const accepted: InboxEvent[] = [];
			for (const event of answer.kind === "events" ? answer.events : []) {
				if (Object.hasOwn(seenHere, event.sourceId)) continue;
				put(seenHere, event.sourceId, now);
				accepted.push({ ...event, watcherId, seq: nextSeq, receivedAt: now, disposition: sort(event) });
				nextSeq += 1;
			}
			const next = trimmed(
				{
					v: 1,
					nextSeq,
					events: [...state.events, ...accepted],
					watchers: { ...state.watchers, [watcherId]: healthAfter(held, answer, now) },
					seen: { ...state.seen, [watcherId]: seenHere },
				},
				now,
			);
			if (!commit(next)) return null;
			const retained = new Set(next.events.map((event) => event.seq));
			return { accepted: structuredClone(accepted.filter((event) => retained.has(event.seq))) };
		},
		// Copies, so only `commitPoll` changes what is held.
		stateOf: (watcherId) => structuredClone(own(state.watchers, watcherId)),
		events: (watcherId) =>
			structuredClone(state.events.filter((event) => watcherId === undefined || event.watcherId === watcherId)),
		unread(watcherId) {
			const read = own(state.watchers, watcherId)?.readSeq ?? 0;
			return state.events.filter(
				(event) => event.watcherId === watcherId && event.disposition === "inbox" && event.seq > read,
			).length;
		},
	};
}
