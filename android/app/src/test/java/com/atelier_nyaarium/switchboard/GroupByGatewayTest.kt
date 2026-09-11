package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the sessions board's machine list: which Gateways get a section, in what order, and
 * what a picked project resolves to once one is pressed.
 */
class GroupByGatewayTest {

	// domainId and gatewayId derive from the qualified name, so the fixtures spell them there.
	private fun team(name: String) = testTeam(name, status = Presence.AVAILABLE)

	private fun keys(groups: List<Pair<GatewayGroupKey, List<Team>>>) = groups.map { it.first.gatewayId }

	@Test
	fun aRosterGatewayWithNoSessionsStillGetsASection() {
		val rows = listOf(team("alice.sakura.claude"))
		val groups = groupByGateway(rows, testRegistry("sakura", "ql-2815"), adminDomainId = "alice")
		assertEquals(listOf("ql-2815", "sakura"), keys(groups))
		assertEquals(emptyList<Team>(), groups.first().second)
	}

	@Test
	fun aRosterGatewayWithSessionsIsNotDrawnTwice() {
		val rows = listOf(team("alice.ql-2815.claude"))
		val groups = groupByGateway(rows, testRegistry("sakura", "ql-2815"), adminDomainId = "alice")
		assertEquals(1, groups.count { it.first.gatewayId == "ql-2815" })
		assertEquals(rows, groups.first { it.first.gatewayId == "ql-2815" }.second)
	}

	@Test
	fun ownDomainSortsFirstThenById() {
		val rows = listOf(team("bob.aaa.claude"), team("alice.zzz.claude"), team("alice.mmm.claude"))
		val groups = groupByGateway(rows, testRegistry("sakura"), adminDomainId = "alice")
		assertEquals(
			listOf("alice/mmm", "alice/sakura", "alice/zzz", "bob/aaa"),
			groups.map { "${it.first.domainId}/${it.first.gatewayId}" },
		)
	}

	@Test
	fun anEmptyRosterInventsNothing() {
		val groups = groupByGateway(emptyList(), GatewayRegistry(), adminDomainId = "alice")
		assertEquals(emptyList<String>(), keys(groups))
	}

	@Test
	fun aPickedProjectIsQualifiedOnItsGateway() {
		val opened = CreateDialogTarget.of("alice", "ql-2815", listOf("host"))
		assertEquals("alice.ql-2815.host", opened.targetFor("host"))
	}

	@Test
	fun anUnqualifiableProjectIsNotOffered() {
		// A separator in the spawn segment cannot make a spawn point, so it is not a choice.
		val opened = CreateDialogTarget.of("alice", "ql-2815", listOf("a.b", "recipe-app"))
		assertEquals(listOf("recipe-app"), opened.projects)
	}

	@Test
	fun emptyBoardKeepsItsCauses() {
		val stalled = ChatState(connected = true, pollFailStreak = 2)
		assertTrue(emptyBoardHasCause(stalled))
		val healthy = ChatState(connected = true)
		assertEquals(false, emptyBoardHasCause(healthy))
	}
}
