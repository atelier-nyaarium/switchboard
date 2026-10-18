// The assistant's inbox: every watcher's events, cursor, health and read position, in one snapshot.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import { type RuleDecision, RuleDecisionSchema } from "../../shared/schemasAssistantRules.js";
import { type PollAnswer, type WatcherEvent, WatcherEventSchema } from "./watcher.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Unread rows past this, per watcher, evict oldest first. */
export const INBOX_CAP = 500;
/** Kept drops per watcher; oldest go first. */
export const DROP_CAP = 1_000;
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
	/** The rules' decision, apart from disposition. */
	decision: RuleDecisionSchema.optional(),
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
	/** The rules revision its kept drops were last sorted under. */
	rulesRevision: z.number().int().nonnegative().optional(),
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

/** The rules a write sorts under. */
export interface Sorter {
	sort: (event: WatcherEvent) => RuleDecision;
	revision: number;
}

/** A wake waits in the inbox until it lands, so only a drop leaves it. */
const placed = (decision: RuleDecision): Pick<InboxEvent, "disposition" | "decision"> => ({
	disposition: decision.action === "drop" ? "ruleDropped" : "inbox",
	decision,
});

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

function appendTo(groups: Map<string, InboxEvent[]>, event: InboxEvent): void {
	const rows = groups.get(event.watcherId);
	if (rows) rows.push(event);
	else groups.set(event.watcherId, [event]);
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
		appendTo(unread, event);
	}
	const over = new Set<InboxEvent>();
	for (const rows of unread.values()) {
		for (const event of rows.slice(0, Math.max(0, rows.length - INBOX_CAP))) over.add(event);
	}
	for (const event of over) lose(event);
	// Drops past the cap go uncounted.
	const drops = new Map<string, InboxEvent[]>();
	for (const event of live) {
		if (event.disposition === "ruleDropped") appendTo(drops, event);
	}
	for (const rows of drops.values()) {
		for (const event of rows.slice(0, Math.max(0, rows.length - DROP_CAP))) over.add(event);
	}
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

/** Any other revision; a fresh rules file restarts at 0. */
function behind(snapshot: Snapshot, watcherId: string, sorter: Sorter): boolean {
	return (own(snapshot.watchers, watcherId)?.rulesRevision ?? 0) !== sorter.revision;
}

/** A caught drop takes a fresh seq. An expired one is left for the trim, never sorted. */
function resorted(snapshot: Snapshot, watcherId: string, sorter: Sorter, now: number): Snapshot {
	let nextSeq = snapshot.nextSeq;
	const events = snapshot.events.map((event) => {
		if (event.watcherId !== watcherId || event.disposition !== "ruleDropped" || !kept(event, now)) return event;
		const decision = sorter.sort(event);
		if (decision.action === "drop") return { ...event, decision };
		const fresh = { ...event, seq: nextSeq, ...placed(decision) };
		nextSeq += 1;
		return fresh;
	});
	const held = own(snapshot.watchers, watcherId) ?? freshWatcher();
	return {
		...snapshot,
		nextSeq,
		events,
		watchers: { ...snapshot.watchers, [watcherId]: { ...held, rulesRevision: sorter.revision } },
	};
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
	 * and `accepted` holds only the rows kept. An inbox not at `sorter`'s revision sorts its kept drops again
	 * in the same write, so a replay that did not land is retried by the next poll.
	 */
	commitPoll(watcherId: string, answer: PollAnswer, now: number, sorter: Sorter): { accepted: InboxEvent[] } | null;
	/**
	 * Sorts the watcher's kept drops again under `sorter`, in one checked write with its revision. A
	 * drop that now wakes or goes to the inbox takes a fresh seq; a row that left, or is past its 7
	 * days, is never sorted again. False when the write did not land.
	 */
	resort(watcherId: string, sorter: Sorter, now: number): boolean;
	stateOf(watcherId: string, now: number): WatcherState | undefined;
	events(watcherId: string | undefined, now: number): InboxEvent[];
	/** Inbox rows past the watcher's read position. */
	unread(watcherId: string, now: number): number;
	/** Unread rows a rule woke for that no wake has landed for yet, oldest first. */
	pendingWakes(now: number): InboxEvent[];
	/** Moves these rows from the inbox to woken, in one checked write. False when it did not land. */
	markWoken(rows: readonly Pick<InboxEvent, "watcherId" | "sourceId">[], now: number): boolean;
	/** Unread inbox rows, oldest first, with the highest seq read per watcher. Moves nothing. */
	flush(
		watcherIds: readonly string[] | undefined,
		now: number,
	): { events: InboxEvent[]; boundaries: Record<string, number> };
	/**
	 * Moves each named read position up to its boundary, never down and never past what is held, in
	 * one checked write. False when it did not land.
	 */
	confirm(boundaries: Readonly<Record<string, number>>, now: number): boolean;
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

	/** Reads and writes share one trim. */
	const asOf = (now: number): Snapshot => trimmed(state, now);

	return {
		commitPoll(watcherId, answer, now, sorter) {
			const current = asOf(now);
			const base = behind(current, watcherId, sorter) ? resorted(current, watcherId, sorter, now) : current;
			const held = own(base.watchers, watcherId) ?? freshWatcher();
			const seenHere = { ...(own(base.seen, watcherId) ?? {}) };
			let nextSeq = base.nextSeq;
			const accepted: InboxEvent[] = [];
			for (const event of answer.kind === "events" ? answer.events : []) {
				if (Object.hasOwn(seenHere, event.sourceId)) continue;
				put(seenHere, event.sourceId, now);
				const decision = sorter.sort(event);
				accepted.push({ ...event, watcherId, seq: nextSeq, receivedAt: now, ...placed(decision) });
				nextSeq += 1;
			}
			const next = trimmed(
				{
					v: 1,
					nextSeq,
					events: [...base.events, ...accepted],
					watchers: { ...base.watchers, [watcherId]: healthAfter(held, answer, now) },
					seen: { ...base.seen, [watcherId]: seenHere },
				},
				now,
			);
			if (!commit(next)) return null;
			const retained = new Set(next.events.map((event) => event.seq));
			return { accepted: structuredClone(accepted.filter((event) => retained.has(event.seq))) };
		},
		resort: (watcherId, sorter, now) => commit(trimmed(resorted(asOf(now), watcherId, sorter, now), now)),
		// Copies; only writes change state.
		stateOf: (watcherId, now) => structuredClone(own(asOf(now).watchers, watcherId)),
		events: (watcherId, now) =>
			structuredClone(
				asOf(now).events.filter((event) => watcherId === undefined || event.watcherId === watcherId),
			),
		unread(watcherId, now) {
			const view = asOf(now);
			return unreadIn(view, watcherId).length;
		},
		pendingWakes(now) {
			const view = asOf(now);
			return structuredClone(
				view.events.filter(
					(event) =>
						event.disposition === "inbox" &&
						event.decision?.action === "wake" &&
						event.seq > (own(view.watchers, event.watcherId)?.readSeq ?? 0),
				),
			);
		},
		markWoken(rows, now) {
			const current = asOf(now);
			const keys = new Set(rows.map(rowKey));
			// A row read meanwhile stays read.
			const events = current.events.map((event) =>
				event.disposition === "inbox" &&
				event.seq > (own(current.watchers, event.watcherId)?.readSeq ?? 0) &&
				keys.has(rowKey(event))
					? { ...event, disposition: "woken" as const }
					: event,
			);
			return commit({ ...current, events });
		},
		flush(watcherIds, now) {
			const view = asOf(now);
			const named = new Set(watcherIds ?? Object.keys(view.watchers));
			const events = [...named].flatMap((watcherId) => unreadIn(view, watcherId));
			const boundaries: Record<string, number> = {};
			for (const event of events)
				put(boundaries, event.watcherId, Math.max(own(boundaries, event.watcherId) ?? 0, event.seq));
			return { events: structuredClone(events.sort((a, b) => a.seq - b.seq)), boundaries };
		},
		confirm(boundaries, now) {
			// From the trimmed inbox, so a row that expired is counted lost before the position passes it.
			const current = asOf(now);
			const ceiling = current.nextSeq - 1;
			const watchers = { ...current.watchers };
			for (const [watcherId, boundary] of Object.entries(boundaries)) {
				const held = own(watchers, watcherId);
				if (!held) continue;
				put(watchers, watcherId, { ...held, readSeq: Math.max(held.readSeq, Math.min(boundary, ceiling)) });
			}
			return commit({ ...current, watchers });
		},
	};
}

function rowKey(row: Pick<InboxEvent, "watcherId" | "sourceId">): string {
	return `${row.watcherId}\u0000${row.sourceId}`;
}

/** Inbox rows past the watcher's read position, in seq order. */
function unreadIn(view: Snapshot, watcherId: string): InboxEvent[] {
	const read = own(view.watchers, watcherId)?.readSeq ?? 0;
	return view.events.filter(
		(event) => event.watcherId === watcherId && event.disposition === "inbox" && event.seq > read,
	);
}
