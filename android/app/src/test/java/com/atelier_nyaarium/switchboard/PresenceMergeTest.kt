package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import com.atelier_nyaarium.switchboard.proto.PresencePlane
import com.atelier_nyaarium.switchboard.proto.RosterEntry
import com.atelier_nyaarium.switchboard.proto.TeamInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresenceMergeTest {
	private class FakeHost : PresenceHost {
		override val state = MutableStateFlow(ChatState())
		override var storedDisplayName = ""
		override val forgottenUntil = mutableMapOf<String, Long>()
		var slot: RouterStateSlot? = null
		var savedLabels: Map<String, String>? = null

		override suspend fun <T> withDrainMutex(block: suspend () -> T): T = block()
		override suspend fun reportRead(team: String, anchor: ReadAnchor) = Unit
		override suspend fun pullPlanes(everything: Boolean) = Unit
		override fun storedRunbooks(gatewayId: String): List<com.atelier_nyaarium.switchboard.proto.Runbook>? = null
		override fun loadRouterState(kind: String) = slot
		override fun saveRouterState(kind: String, slot: RouterStateSlot) { this.slot = slot }
		override fun persistLabels(labels: Map<String, String>) { savedLabels = labels }
		override fun persistAbsenceStreaks(streaks: Map<String, Int>) = Unit
		override fun persistReadAnchors(anchors: Map<String, ReadAnchor>) = Unit
		override fun receiptFor(team: String, now: Long): ActionReceipt? = null
		override fun clearReceipt(team: String) = Unit
	}

	private fun row(team: String, gatewayId: String) = TeamInfo(
		team = team,
		gatewayId = gatewayId,
		domainId = "dom1",
		status = Presence.ONLINE,
		kind = "loose",
		queue_depth = 0,
	)

	private fun projection(version: Long, rows: List<TeamInfo>) = OwnerPresenceProjection(
		plane = PresencePlane(1, version),
		owner = OwnerFacts("dom1", null, false),
		rows = rows,
		linked = emptyList(),
		roster = listOf(RosterEntry("sakura", true, 1, 1), RosterEntry("mikan", false, 1, 1)),
		coverage = DiscoverCoverage(true, 2, 2),
		spawnPoints = emptyList(),
	)

	@Test
	fun aCoveredPeerSessionLeavesTheRenderedBoard() = runBlocking {
		val host = FakeHost()
		val ops = PresenceOps(host)
		ops.applyOwnerProjection(projection(1, listOf(row("host.session", "sakura"), row("host.session", "mikan"))))
		ops.applyOwnerProjection(projection(2, listOf(row("host.session", "sakura"))))

		assertEquals(listOf("dom1.sakura.host.session"), host.state.value.teams.map { it.name })
		assertEquals(emptyMap<String, String>(), host.savedLabels)
	}

	private val domain = "dom1"

	private fun prior(gateway: String, session: String, rowDomain: String = domain) =
		testTeam(name = "$rowDomain.$gateway.host.$session")

	@Test
	fun theProjectionSpeaksForEveryOwnDomainRowAndNoFriendRow() {
		assertFalse(keepPriorRow(prior("mikan", "c2fe43"), domain))
		assertFalse(keepPriorRow(prior("yuzu", "bb22"), domain))
		assertTrue(keepPriorRow(prior("elderberry", "aa11", rowDomain = "dom2"), domain))
	}

	@Test
	fun mergeKeepsAFreshRowOverThePriorOneAndDropsWhatTheRuleRefuses() {
		val kept = listOf(prior("mikan", "c2fe43"), prior("mikan", "01f24f"), prior("elderberry", "aa11", rowDomain = "dom2"))
		val fresh = listOf(prior("mikan", "01f24f"))
		val merged = mergePresence(kept, fresh) { keepPriorRow(it, domain) }
		assertEquals(listOf("$domain.mikan.host.01f24f", "dom2.elderberry.host.aa11"), merged.map { it.name })
	}
}
