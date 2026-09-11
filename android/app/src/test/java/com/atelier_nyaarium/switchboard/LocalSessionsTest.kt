package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Unit tests for localSessions: the board's local/peer split, the one guard against a linked
 * friend's session double-rendering in both the flattened board and the Linked friends section.
 */
class LocalSessionsTest {

	private fun team(name: String) = testTeam(name, status = Presence.AVAILABLE)

	@Test
	fun sessionsOnTheOwnDomainAreLocal() {
		val t = team("alice.gw.claude")
		assertEquals(listOf(t), localSessions(listOf(t), adminDomainId = "alice"))
	}

	@Test
	fun sessionsFromAnotherDomainAreExcluded() {
		val mine = team("alice.gw.claude")
		val peer = team("bob.gw.claude")
		assertEquals(listOf(mine), localSessions(listOf(mine, peer), adminDomainId = "alice"))
	}

	@Test
	fun noDomainYetMeansNoLocalSessions() {
		val tagged = team("bob.gw.claude")
		assertEquals(emptyList<Team>(), localSessions(listOf(tagged), adminDomainId = ""))
	}
}
