// What automations leave for the assistant, within the lane's bounds.

import { createHash } from "node:crypto";
import { z } from "zod";
import { TELL_WHEN, type TellWhen } from "../../shared/schemasAutomation.js";

export const QUEUE_MAX_EVENTS = 256;
export const QUEUE_MAX_BYTES = 64 * 1024;
/** A told title or field. */
export const TOLD_FIELD_MAX = 1_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Within retention. */
export const retained = (entry: { at: number }, now: number): boolean => now - entry.at < RETENTION_MS;
const MEMBER_MAX = 256;
const FIELD_NAME_MAX = 64;
const FIELDS_MAX = 32;
export const QUEUE_FULL = "the automations outbox is full";

const MEMBER_HEAD = "automation";

/** A long member keeps its head and a digest of the whole. */
export function memberOf(automation: string, ...parts: (string | number)[]): string {
	const member = [MEMBER_HEAD, automation, ...parts].join(":");
	if (member.length <= MEMBER_MAX) return member;
	const digest = createHash("sha256").update(member).digest("hex");
	return `${member.slice(0, MEMBER_MAX - digest.length - 1)}:${digest}`;
}

/** Ids hold no colon, and a digest keeps the head. */
export function ownerOf(member: string): string | null {
	const [head, automation] = member.split(":", 2);
	return head === MEMBER_HEAD && automation ? automation : null;
}

/** Unreadable bodies stay queued. */
export const QueueEntrySchema = z.strictObject({ member: z.string(), at: z.number().int(), body: z.unknown() });
export type QueueEntry = z.infer<typeof QueueEntrySchema>;
export interface QueueState {
	lastAt: number;
	events: QueueEntry[];
}

/** Bounded as the lane's reader bounds an event. */
const EventBodySchema = z.strictObject({
	title: z.string().max(TOLD_FIELD_MAX),
	fields: z
		.record(z.string().max(FIELD_NAME_MAX), z.string().max(TOLD_FIELD_MAX))
		.refine((fields) => Object.keys(fields).length <= FIELDS_MAX),
	/** Absent: quietly. */
	when: z.enum(TELL_WHEN).optional(),
});

export interface OutboxEvent {
	id: string;
	at: number;
	title: string;
	fields: Record<string, string>;
	when: TellWhen;
}

/** What automations left for the assistant. */
export interface AutomationOutbox {
	/** Moves with every append. */
	revision: () => number;
	/** Oldest first. */
	events: () => OutboxEvent[];
}

const queueBytes = (events: readonly QueueEntry[]) => Buffer.byteLength(JSON.stringify(events));

export const clip = (text: string) => text.slice(0, TOLD_FIELD_MAX);

/** The one writer of `when`. */
const toldEntry = (member: string, when: TellWhen, title: string, fields: Record<string, string>, at: number) => ({
	member,
	at,
	body: { title, ...(when === "now" ? { when: "now" } : {}), fields },
});

/** The one reader of `when`; null when unreadable. */
const readEntry = (entry: QueueEntry): OutboxEvent | null => {
	const body = EventBodySchema.safeParse(entry.body);
	if (!body.success || entry.member.length > MEMBER_MAX) return null;
	const { when = "quietly", ...shown } = body.data;
	return { id: entry.member, at: entry.at, ...shown, when };
};

/** Quiet entries lost, by owner; null owns an unowned member. */
export type Dropped = Map<string | null, number>;

/** Drops the biggest owner's oldest quiet entry until it fits; null when only urgent ones remain. */
export function roomFor(
	events: readonly QueueEntry[],
	entry: QueueEntry,
	now: number,
): { events: QueueEntry[]; dropped: Dropped } | null {
	const kept = [...events.filter((event) => retained(event, now)), entry];
	const quiet = (held: QueueEntry) => {
		const read = readEntry(held);
		return read && read.when !== "now" ? { owner: ownerOf(held.member) } : null;
	};
	const asker = quiet(entry);
	const owners = kept.map((held, index) => (index < kept.length - 1 ? quiet(held) : null));
	let bytes = queueBytes(kept);
	const dropped: Dropped = new Map();
	while (kept.length > QUEUE_MAX_EVENTS || bytes > QUEUE_MAX_BYTES) {
		const shares = new Map<string | null, number>();
		for (const held of owners) if (held) shares.set(held.owner, (shares.get(held.owner) ?? 0) + 1);
		let largest: { owner: string | null; count: number } | null = null;
		for (const [held, count] of shares) {
			const asks = asker !== null && asker.owner === held;
			const counted = count + (asks ? 1 : 0);
			if (!largest || counted > largest.count || (counted === largest.count && asks))
				largest = { owner: held, count: counted };
		}
		if (!largest) return null;
		const owner = largest.owner;
		const at = owners.findIndex((held) => held !== null && held.owner === owner);
		const [gone] = kept.splice(at, 1);
		owners.splice(at, 1);
		// Entry and comma.
		bytes -= queueBytes([gone as QueueEntry]) - 1;
		dropped.set(owner, (dropped.get(owner) ?? 0) + 1);
	}
	return { events: kept, dropped };
}

/** Quiet entries make room. */
export const told = (
	queue: QueueState,
	entry: { member: string; when: TellWhen; fields: Record<string, string> },
	sentence: string,
	now: number,
): { queue: QueueState; dropped: Dropped } | null => {
	const at = Math.max(now, queue.lastAt + 1);
	const title = clip(sentence);
	const event = toldEntry(entry.member, entry.when, title, { automation: title, ...entry.fields }, at);
	const room = roomFor(queue.events, event, now);
	return room && { queue: { lastAt: at, events: room.events }, dropped: room.dropped };
};

export const outboxOf = (queue: () => QueueState, now: () => number): AutomationOutbox => ({
	revision: () => queue().lastAt,
	/** Unreadable and expired entries stay hidden. */
	events: () => queue().events.flatMap((event) => (retained(event, now()) ? (readEntry(event) ?? []) : [])),
});
