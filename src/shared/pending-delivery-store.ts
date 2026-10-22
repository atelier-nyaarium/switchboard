import { createHash } from "node:crypto";
import type { Clock } from "./ambient.js";
import { DurableOutbox } from "./durable-outbox.js";
import { fenced, MIGRATING } from "./migration-fence.js";
import { type ChannelFile, MAX_PENDING_DELIVERIES, type ReplyDisposition, type RidingAwareness } from "./types.js";

interface HeldRow {
	/** Stable retry identity. */
	deliveryId: string;
	team: string;
	body: string;
	enqueuedAt: number;
}

export interface MessageDelivery extends HeldRow {
	event?: never;
	channelJobId: string;
	from: string;
	files?: ChannelFile[];
	disposition?: ReplyDisposition;
	/** Reserved before delivery. */
	awareness?: RidingAwareness;
	/** Materialization bucket key. */
	messageId?: string;
}

/** A watcher event. */
export interface EventDelivery extends HeldRow {
	event: true;
	/** Each emitted once. */
	keys?: string[];
}

export type PendingDelivery = MessageDelivery | EventDelivery;

/** One source item of an event. */
export interface EventMember {
	key: string;
	text: string;
}

export type EnqueueOutcome = "enqueued" | "duplicate" | "refused" | "migrating";

/** Every member already held or emitted. */
export const SEEN = "seen";

interface Emitted {
	key: string;
	at: number;
}

interface Snapshot {
	deliveries: PendingDelivery[];
	/** Event members already emitted. */
	emitted?: Emitted[];
}

export interface DeliverySnapshotSink {
	load(): unknown | null;
	saveChecked(state: unknown): void;
}

export const PENDING_DELIVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_PENDING_DELIVERIES_PER_TEAM = 200;
export { MAX_PENDING_DELIVERIES };
/** A runaway bound; the TTL prunes first. */
export const MAX_EMITTED_KEYS = 50_000;

export class PendingDeliveryStore {
	// Rows remain until acknowledgement.
	private readonly outbox: DurableOutbox<PendingDelivery>;
	/** Saved with the rows, so a row and its retirement land together. */
	private emitted: Emitted[] = [];

	constructor(
		durable: DeliverySnapshotSink | undefined,
		private readonly ambient: Clock,
		private readonly ttlMs: number = PENDING_DELIVERY_TTL_MS,
		private readonly maxPerTeam: number = MAX_PENDING_DELIVERIES_PER_TEAM,
		maxTotal: number = MAX_PENDING_DELIVERIES,
	) {
		this.outbox = new DurableOutbox({
			durable,
			restore: (raw) => {
				if (!raw || typeof raw !== "object") return [];
				this.emitted = emittedOf((raw as Snapshot).emitted);
				const rows = (raw as Snapshot).deliveries;
				if (!Array.isArray(rows)) return [];
				const ids = new Set<string>();
				return rows.filter((row): row is PendingDelivery => {
					if (!isDelivery(row) || ids.has(row.deliveryId)) return false;
					ids.add(row.deliveryId);
					return true;
				});
			},
			serialize: (items) => ({ deliveries: [...this.groupByTeam(items)], emitted: this.emitted }),
			keyOf: (item) => item.deliveryId,
			maxSize: maxTotal,
		});
	}

	get size(): number {
		return this.outbox.size;
	}

	/** Refuses when full, or when the id is held by the other arm. */
	enqueue(delivery: PendingDelivery): EnqueueOutcome {
		if (fenced()) return MIGRATING;
		if (this.outbox.has(delivery.deliveryId)) {
			const held = this.outbox.values().find((row) => row.deliveryId === delivery.deliveryId);
			return held?.event === delivery.event ? "duplicate" : "refused";
		}
		if (this.listForTeam(delivery.team).length >= this.maxPerTeam) return "refused";
		const result = this.outbox.enqueue(delivery);
		return result === "enqueued" ? result : result === MIGRATING ? MIGRATING : "refused";
	}

	/** Unseen members, as one row. */
	enqueueEvent(input: { team: string; members: readonly EventMember[]; enqueuedAt: number }): {
		outcome: EnqueueOutcome | typeof SEEN;
		row?: EventDelivery;
	} {
		if (fenced()) return { outcome: MIGRATING };
		const seen = new Set(this.emitted.map((emitted) => emitted.key));
		for (const row of this.listForTeam(input.team)) {
			for (const key of row.event ? (row.keys ?? []) : []) seen.add(key);
		}
		const fresh = input.members.filter((member) => !seen.has(member.key) && Boolean(seen.add(member.key)));
		if (fresh.length === 0) return { outcome: SEEN };
		const keys = fresh.map((member) => member.key);
		const row: EventDelivery = {
			deliveryId: eventIdOf(keys),
			team: input.team,
			body: fresh.map((member) => member.text).join("\n\n"),
			event: true,
			keys,
			enqueuedAt: input.enqueuedAt,
		};
		return { outcome: this.enqueue(row), row };
	}

	listForTeam(team: string): readonly PendingDelivery[] {
		return this.outbox.values().filter((delivery) => delivery.team === team);
	}

	/** An event row's members are remembered as emitted in the same write. */
	acknowledge(deliveryId: string): boolean | typeof MIGRATING {
		const held = this.outbox.values().find((row) => row.deliveryId === deliveryId);
		const before = this.emitted;
		if (held?.event && held.keys) {
			const at = this.ambient.now();
			this.emitted = [...before, ...held.keys.map((key) => ({ key, at }))].slice(-MAX_EMITTED_KEYS);
		}
		try {
			const retired = this.outbox.retire(deliveryId);
			if (retired !== true) this.emitted = before;
			return retired;
		} catch (error) {
			this.emitted = before;
			throw error;
		}
	}

	failTeam(team: string): PendingDelivery[] | typeof MIGRATING {
		return this.outbox.retireWhere((delivery) => delivery.team === team);
	}

	sweep(): PendingDelivery[] | typeof MIGRATING {
		if (fenced()) return MIGRATING;
		const cutoff = this.ambient.now() - this.ttlMs;
		this.emitted = this.emitted.filter((emitted) => emitted.at > cutoff);
		return this.outbox.retireWhere((delivery) => delivery.enqueuedAt <= cutoff);
	}

	snapshot(): Snapshot {
		return { deliveries: [...this.groupByTeam(this.outbox.values())] };
	}

	private groupByTeam(items: readonly PendingDelivery[]): PendingDelivery[] {
		const teams = new Map<string, PendingDelivery[]>();
		for (const delivery of items) {
			const queue = teams.get(delivery.team) ?? [];
			queue.push(delivery);
			teams.set(delivery.team, queue);
		}
		return [...teams.values()].flat();
	}
}

function eventIdOf(keys: readonly string[]): string {
	return `event:${createHash("sha256").update(JSON.stringify(keys)).digest("hex").slice(0, 32)}`;
}

function emittedOf(raw: unknown): Emitted[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((entry): entry is Emitted => typeof entry?.key === "string" && typeof entry?.at === "number")
		.slice(-MAX_EMITTED_KEYS);
}

/** Reject incomplete restored rows. */
function isDelivery(row: unknown): row is PendingDelivery {
	if (!row || typeof row !== "object") return false;
	const d = row as Record<string, unknown>;
	const held =
		typeof d.deliveryId === "string" &&
		d.deliveryId.length > 0 &&
		typeof d.team === "string" &&
		d.team.length > 0 &&
		typeof d.body === "string" &&
		typeof d.enqueuedAt === "number";
	if (!held) return false;
	if (d.event === true) {
		const keyed = d.keys === undefined || (Array.isArray(d.keys) && d.keys.every((key) => typeof key === "string"));
		return keyed && d.channelJobId === undefined && d.from === undefined;
	}
	return d.event === undefined && typeof d.channelJobId === "string" && typeof d.from === "string";
}
