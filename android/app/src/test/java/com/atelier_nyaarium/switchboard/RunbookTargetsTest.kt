package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.runbooks.sessionTargets
import com.atelier_nyaarium.switchboard.runbooks.spawnChoices
import com.atelier_nyaarium.switchboard.runbooks.spawnMenu
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
		domainId = "d1",
	)

	@Test
	fun aNewSessionOffersQualifiedSpawnPointsAndAnExistingOneOffersQualifiedSessions() {
		assertEquals(listOf("d1.sakura.host", "d1.sakura.evie-bot"), spawnTargets(state, "sakura").map { it.address })
		assertEquals(listOf("host", "evie-bot"), spawnTargets(state, "sakura").map { it.label })
		assertEquals(
			listOf("d1.sakura.host.567375", "d1.sakura.host.abc"),
			sessionTargets(state, "sakura").map { it.address }.sorted(),
		)
	}

	@Test
	fun aDevcontainerIsASpawnPointRatherThanSomethingToFireInto() {
		assertEquals(false, sessionTargets(state, "sakura").any { it.address == "d1.sakura.evie-bot" })
	}

	@Test
	fun anotherGatewaysTargetsNeverAppearUnderThisOne() {
		assertEquals(listOf("d1.mikan.host", "d1.mikan.nyaakube"), spawnTargets(state, "mikan").map { it.address })
		assertEquals(listOf("d1.mikan.host.999"), sessionTargets(state, "mikan").map { it.address })
	}

	@Test
	fun noDomainYetOffersNothingToFireInto() {
		assertEquals(emptyList<String>(), spawnTargets(state.copy(domainId = null), "sakura").map { it.address })
	}

	@Test
	fun aRoutineStoresTheBareSpawnAndAHeldOneNoLongerOfferedStaysFirstAndMarked() {
		val choices = spawnChoices(state, "sakura")
		assertEquals(listOf("host", "evie-bot"), choices.map { it.spawn })
		assertEquals(choices, spawnMenu(choices, "host"))
		assertEquals(choices, spawnMenu(choices, ""))

		val menu = spawnMenu(choices, "old-sandbox")
		assertEquals(listOf("old-sandbox", "host", "evie-bot"), menu.map { it.spawn })
		assertEquals(listOf(false, true, true), menu.map { it.offered })
	}

	@Test
	fun aDevcontainerNamedLikeAHostSpawnDoesNotDoubleIt() {
		val collided = state.copy(teams = state.teams + team("d1.sakura.host", kind = "devcontainer"))
		assertEquals(listOf("host", "evie-bot"), spawnChoices(collided, "sakura").map { it.spawn })
	}
}
