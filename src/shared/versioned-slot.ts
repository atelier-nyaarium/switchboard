// The fold every reader of a Router-held versioned slot applies; VersionedSlot.kt is the twin, pinned by shared vectors.

/** Where a Router plane stands. `epoch` is a random tag compared for equality only; `version` orders inside it. */
export interface PlaneLineage {
	epoch: number;
	version: number;
}

/** What a reader holds. `observed` is the reader's own stamp at receipt; a durable value carries none. */
export interface HeldLineage {
	lineage: PlaneLineage | null;
	observed: number | null;
}

export type SlotFold =
	/** Land it. `lineageChanged` says what was held belongs to a lineage that is gone. */
	| { kind: "take"; lineageChanged: boolean }
	/** Landed at exactly this lineage already. */
	| { kind: "held" }
	/** A late arrival. */
	| { kind: "behind" };

/** Within a lineage the Router's version orders; across lineages the reader's own observation order does. */
export function foldVersionedSlot(held: HeldLineage, incoming: PlaneLineage, observedAt: number): SlotFold {
	const lineage = held.lineage;
	if (lineage === null) return { kind: "take", lineageChanged: false };
	if (lineage.epoch !== incoming.epoch)
		return observedAt > (held.observed ?? 0) ? { kind: "take", lineageChanged: true } : { kind: "behind" };
	if (incoming.version > lineage.version) return { kind: "take", lineageChanged: false };
	return incoming.version < lineage.version ? { kind: "behind" } : { kind: "held" };
}
