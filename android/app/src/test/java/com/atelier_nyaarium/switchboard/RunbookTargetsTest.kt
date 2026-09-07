package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import com.atelier_nyaarium.switchboard.runbooks.gatewayTargets
import com.atelier_nyaarium.switchboard.runbooks.sessionTargets
import com.atelier_nyaarium.switchboard.runbooks.spawnTargets
import org.junit.Assert.assertEquals
import org.junit.Test

class RunbookTargetsTest {
	private fun team(name: String, kind: String = "loose") =
		Team(name = name, presence = Presence.ended(), kind = kind, domainId = "d1")

	private val state = ChatState(
		teams = listOf(
			team("d1.sakura.host.567375"),
			team("d1.sakura.evie-bot", kind = "devcontainer"),
			team("d1.sakura.host.abc"),
			team("d1.mikan.host.999"),
			team("d1.mikan.nyaakube", kind = "devcontainer"),
		),
		gatewaySpawnPoints = listOf(
			GatewaySpawnPoints(domainId = "d1", gatewayId = "sakura", hostSpawns = listOf("host")),
			GatewaySpawnPoints(domainId = "d1", gatewayId = "mikan", hostSpawns = listOf("host")),
		),
		admittedGateways = listOf("mikan"),
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
		assertEquals(listOf("sakura", "mikan"), gatewayTargets(state))
	}
}
