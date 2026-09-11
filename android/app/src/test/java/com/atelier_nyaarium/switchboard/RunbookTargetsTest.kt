package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.runbooks.sessionTargets
import com.atelier_nyaarium.switchboard.runbooks.spawnTargets
import org.junit.Assert.assertEquals
import org.junit.Test

class RunbookTargetsTest {
	private fun team(name: String, kind: String = "loose") = Team(name = name, presence = Presence.ended(), kind = kind)

	private val state = ChatState(
		teams = listOf(
			team("d1.sakura.host.567375"),
			team("d1.sakura.evie-bot", kind = "devcontainer"),
			team("d1.sakura.host.abc"),
			team("d1.mikan.host.999"),
			team("d1.mikan.nyaakube", kind = "devcontainer"),
		),
		gateways = testRegistry("sakura", "mikan")
			.withEntry("sakura") { it.copy(hostSpawns = emptyList()) }
			.withEntry("mikan") { it.copy(hostSpawns = listOf("host")) },
		homeGatewayId = "sakura",
		domainId = "d1",
	)

	@Test
	fun aNewSessionOffersSpawnPointsAndAnExistingOneOffersSessions() {
		assertEquals(listOf("host", "evie-bot"), spawnTargets(state, "sakura").map { it.address })
		assertEquals(listOf("host.567375", "host.abc"), sessionTargets(state, "sakura").map { it.address }.sorted())
	}

	@Test
	fun aDevcontainerIsASpawnPointRatherThanSomethingToFireInto() {
		assertEquals(false, sessionTargets(state, "sakura").any { it.address == "evie-bot" })
	}

	@Test
	fun anotherGatewaysTargetsNeverAppearUnderThisOne() {
		assertEquals(listOf("host", "nyaakube"), spawnTargets(state, "mikan").map { it.address })
		assertEquals(listOf("host.999"), sessionTargets(state, "mikan").map { it.address })
	}
}
