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

/** The lineage the last fetch was for, and when it started. */
internal data class PlaneFetch(val lineage: PlaneLineage, val at: Long)

/**
 * The held lineage is durable and carries no observation, so another lineage always fetches, throttle
 * or not. Only a version a fetch already asked for waits; a newer one is news.
 */
internal fun revisionPlaneDecision(
	held: HeldLineage,
	incoming: PlaneLineage,
	fetched: PlaneFetch?,
	now: Long,
): RevisionPlaneDecision {
	val fold = foldVersionedSlot(held, incoming, 1L) as? SlotFold.Take ?: return RevisionPlaneDecision.Acknowledge
	if (
		!fold.lineageChanged &&
		fetched != null &&
		fetched.lineage.epoch == incoming.epoch &&
		incoming.version <= fetched.lineage.version &&
		now - fetched.at < PLANE_FETCH_RETRY_MS
	) {
		return RevisionPlaneDecision.Wait
	}
	return RevisionPlaneDecision.Fetch(incoming.epoch)
}
