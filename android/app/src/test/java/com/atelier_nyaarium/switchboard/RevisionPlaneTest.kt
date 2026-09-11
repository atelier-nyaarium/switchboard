package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PlaneLineage
import org.junit.Assert.assertEquals
import org.junit.Test

class RevisionPlaneTest {
	private val held = HeldLineage(PlaneLineage(7, 3), null)

	@Test
	fun aListAtThePlaneOrPastItIsAcknowledged() {
		assertEquals(RevisionPlaneDecision.Acknowledge, revisionPlaneDecision(held, PlaneLineage(7, 3), null, 1_000L))
		assertEquals(RevisionPlaneDecision.Acknowledge, revisionPlaneDecision(held, PlaneLineage(7, 2), null, 1_000L))
	}

	@Test
	fun aPlanePastTheListFetchesOnceAWindow() {
		assertEquals(RevisionPlaneDecision.Fetch(7), revisionPlaneDecision(held, PlaneLineage(7, 4), null, 1_000L))
		assertEquals(RevisionPlaneDecision.Wait, revisionPlaneDecision(held, PlaneLineage(7, 4), 1_000L, 30_000L))
		assertEquals(RevisionPlaneDecision.Fetch(7), revisionPlaneDecision(held, PlaneLineage(7, 4), 1_000L, 61_000L))
	}

	@Test
	fun anotherLineageFetchesWhateverItsVersionAndInsideTheWindow() {
		assertEquals(RevisionPlaneDecision.Fetch(9), revisionPlaneDecision(held, PlaneLineage(9, 1), null, 1_000L))
		assertEquals(RevisionPlaneDecision.Fetch(9), revisionPlaneDecision(held, PlaneLineage(9, 1), 1_000L, 30_000L))
		assertEquals(RevisionPlaneDecision.Fetch(9), revisionPlaneDecision(HeldLineage.NONE, PlaneLineage(9, 0), null, 1_000L))
	}
}
