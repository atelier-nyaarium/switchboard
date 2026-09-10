package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PlaneLineage

// Twin of src/shared/versioned-slot.ts, pinned by tests/fixtures/versioned-slot/vectors.json.

/** What a reader holds. `observed` is the reader's own stamp at receipt; a durable value carries none. */
data class HeldLineage(val lineage: PlaneLineage?, val observed: Long?) {
	companion object {
		val NONE = HeldLineage(null, null)
	}
}

sealed interface SlotFold {
	/** Land it. `lineageChanged` says what was held belongs to a lineage that is gone. */
	data class Take(val lineageChanged: Boolean) : SlotFold

	/** Landed at exactly this lineage already. */
	data object Held : SlotFold

	/** A late arrival. */
	data object Behind : SlotFold
}

/** Within a lineage the Router's version orders; across lineages the reader's own observation order does. */
fun foldVersionedSlot(held: HeldLineage, incoming: PlaneLineage, observedAt: Long): SlotFold {
	val lineage = held.lineage ?: return SlotFold.Take(lineageChanged = false)
	if (lineage.epoch != incoming.epoch) {
		return if (observedAt > (held.observed ?: 0L)) SlotFold.Take(lineageChanged = true) else SlotFold.Behind
	}
	if (incoming.version > lineage.version) return SlotFold.Take(lineageChanged = false)
	return if (incoming.version < lineage.version) SlotFold.Behind else SlotFold.Held
}
