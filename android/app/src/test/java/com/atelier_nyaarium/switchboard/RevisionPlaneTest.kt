package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.PlaneLineage
import org.junit.Assert.assertEquals
import org.junit.Test

class RevisionPlaneTest {
	private val held = HeldLineage(PlaneLineage(7, 3), null)
	private val askedFor4 = PlaneFetch(PlaneLineage(7, 4), 1_000L)

	@Test
	fun aListAtThePlaneOrPastItIsAcknowledged() {
		assertEquals(RevisionPlaneDecision.Acknowledge, revisionPlaneDecision(held, PlaneLineage(7, 3), null, 1_000L))
		assertEquals(RevisionPlaneDecision.Acknowledge, revisionPlaneDecision(held, PlaneLineage(7, 2), null, 1_000L))
	}

	@Test
	fun aVersionAlreadyAskedForFetchesOnceAWindow() {
		assertEquals(RevisionPlaneDecision.Fetch(7), revisionPlaneDecision(held, PlaneLineage(7, 4), null, 1_000L))
		assertEquals(RevisionPlaneDecision.Wait, revisionPlaneDecision(held, PlaneLineage(7, 4), askedFor4, 30_000L))
		assertEquals(RevisionPlaneDecision.Fetch(7), revisionPlaneDecision(held, PlaneLineage(7, 4), askedFor4, 61_000L))
	}

	@Test
	fun aNewerVersionFetchesInsideTheWindow() {
		// The list landed at 4, and a second change followed it within the minute.
		val landed = HeldLineage(PlaneLineage(7, 4), null)
		assertEquals(RevisionPlaneDecision.Fetch(7), revisionPlaneDecision(landed, PlaneLineage(7, 5), askedFor4, 10_000L))
		// The first fetch has not landed yet.
		assertEquals(RevisionPlaneDecision.Fetch(7), revisionPlaneDecision(held, PlaneLineage(7, 5), askedFor4, 10_000L))
	}

	@Test
	fun anotherLineageFetchesWhateverItsVersionAndInsideTheWindow() {
		assertEquals(RevisionPlaneDecision.Fetch(9), revisionPlaneDecision(held, PlaneLineage(9, 1), null, 1_000L))
		assertEquals(RevisionPlaneDecision.Fetch(9), revisionPlaneDecision(held, PlaneLineage(9, 1), askedFor4, 30_000L))
		assertEquals(RevisionPlaneDecision.Fetch(9), revisionPlaneDecision(HeldLineage.NONE, PlaneLineage(9, 0), null, 1_000L))
	}
}
