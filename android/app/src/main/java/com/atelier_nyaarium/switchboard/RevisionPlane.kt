package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PlaneLineage

// A plane the list never reaches is fetched at most once a minute.
internal const val PLANE_FETCH_RETRY_MS = 60_000L

sealed interface RevisionPlaneDecision {
	/** The held list is at the plane or past it. */
	data object Acknowledge : RevisionPlaneDecision

	/** Adopt the lineage, then read the list. */
	data class Fetch(val epoch: Long) : RevisionPlaneDecision

	/** A fetch is still in its window. */
	data object Wait : RevisionPlaneDecision
}

/** The held lineage is durable and carries no observation, so another lineage always fetches, throttle or not. */
internal fun revisionPlaneDecision(
	held: HeldLineage,
	incoming: PlaneLineage,
	fetchedAt: Long?,
	now: Long,
): RevisionPlaneDecision {
	val fold = foldVersionedSlot(held, incoming, 1L) as? SlotFold.Take ?: return RevisionPlaneDecision.Acknowledge
	if (!fold.lineageChanged && fetchedAt != null && now - fetchedAt < PLANE_FETCH_RETRY_MS) return RevisionPlaneDecision.Wait
	return RevisionPlaneDecision.Fetch(incoming.epoch)
}
