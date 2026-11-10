package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.DiscoverCoverage
import com.atelier_nyaarium.switchboard.proto.GatewaySpawnPoints
import com.atelier_nyaarium.switchboard.proto.HarnessSpawns
import com.atelier_nyaarium.switchboard.proto.OwnerFacts
import com.atelier_nyaarium.switchboard.proto.OwnerPresenceProjection
import com.atelier_nyaarium.switchboard.proto.PresencePlane
import com.atelier_nyaarium.switchboard.proto.RosterEntry
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The CLI pick and macros. */
class SessionHarnessPickTest {
	private val projects = listOf("host", "windows", "recipe-app")

	private fun agents(vararg installed: SessionHarness) = SpawnAgents(installed.toSet())

	private fun landed(vararg rows: GatewaySpawnPoints): GatewayRegistry =
		GatewayRegistry().landed(
			OwnerPresenceProjection(
				plane = PresencePlane(epoch = 1, version = 1),
				owner = OwnerFacts("d", null, false),
				rows = emptyList(),
				linked = emptyList(),
				roster = rows.map { RosterEntry(it.gatewayId, true, 1, 1) },
				coverage = DiscoverCoverage(rosterKnown = true, asked = 1, answered = 1),
				spawnPoints = rows.toList(),
			),
			RegistryProvenance.Current,
		) { null }

	private fun row(
		gatewayId: String,
		harnessSpawns: HarnessSpawns? = null,
		claudeSpawns: List<String>? = null,
		copilotSpawns: List<String>? = null,
	) = GatewaySpawnPoints(
		gatewayId = gatewayId,
		domainId = "d",
		hostSpawns = listOf("windows"),
		harnessSpawns = harnessSpawns,
		claudeSpawns = claudeSpawns,
		copilotSpawns = copilotSpawns,
	)

	@Test
	fun `a project is offered when its spawn point runs any agent`() {
		val held: (String) -> SpawnAgents = { project ->
			when (project) {
				"recipe-app" -> agents(SessionHarness.CLAUDE)
				"windows" -> agents(SessionHarness.COPILOT)
				else -> agents()
			}
		}

		assertEquals(listOf("windows", "recipe-app"), spawnableProjects(projects, held))
	}

	@Test
	fun `a picked project offers the agents its spawn point runs, and keeps the held one when it can`() {
		val both = harnessesOf(agents(SessionHarness.COPILOT, SessionHarness.CLAUDE))
		val copilotOnly = harnessesOf(agents(SessionHarness.COPILOT))

		assertEquals(listOf(SessionHarness.CLAUDE, SessionHarness.COPILOT), both)
		assertEquals(listOf(SessionHarness.COPILOT), copilotOnly)
		assertEquals(SessionHarness.COPILOT, harnessAfterPick(SessionHarness.COPILOT, both))
		assertEquals(SessionHarness.COPILOT, harnessAfterPick(SessionHarness.CLAUDE, copilotOnly))
		assertNull(harnessAfterPick(SessionHarness.CLAUDE, emptyList()))
	}

	@Test
	fun `each install pair shows where its agent is, and every pair where none is`() {
		val claude = SessionHarness.CLAUDE.shellMacros
		val copilot = SessionHarness.COPILOT.shellMacros

		assertEquals(claude, shellMacros(agents(SessionHarness.CLAUDE)))
		assertEquals(copilot, shellMacros(agents(SessionHarness.COPILOT)))
		assertEquals(claude + copilot, shellMacros(agents(SessionHarness.CLAUDE, SessionHarness.COPILOT)))
		assertEquals(SessionHarness.entries.flatMap { it.shellMacros }, shellMacros(agents()))
	}

	@Test
	fun `a session row with no CLI word reads as Claude, and an unknown word as no CLI with no palette`() {
		assertEquals(SessionHarness.COPILOT, rowHarness(SessionHarness.COPILOT.wire))
		assertEquals(SessionHarness.CLAUDE, rowHarness(null))
		assertNull(rowHarness("not-a-cli"))

		assertEquals(SessionHarness.COPILOT.slashPalette, slashMacros(SessionHarness.COPILOT.wire))
		assertEquals(SessionHarness.CLAUDE.slashPalette, slashMacros(null))
		assertTrue(slashMacros("not-a-cli").isEmpty())
	}

	@Test
	fun `a devcontainer runs Claude, and an older Gateway reads as Claude on every host spawn point`() {
		val registry = GatewayRegistry()

		assertEquals(agents(SessionHarness.CLAUDE), registry.agentsOn("mikan", "recipe-app"))
		assertEquals(agents(SessionHarness.CLAUDE), registry.agentsOn("mikan", "host"))
		assertEquals(agents(SessionHarness.CLAUDE), registry.agentsOnSession("d.mikan.recipe-app"))
	}

	@Test
	fun `a spawn point's agents come from the per-CLI map, and from the two old lists without one`() {
		val registry = landed(
			row(
				"mapped",
				harnessSpawns = HarnessSpawns(claude = listOf("windows"), copilot = listOf("host", "windows")),
				claudeSpawns = listOf("host"),
				copilotSpawns = emptyList(),
			),
			row("unprobed", harnessSpawns = HarnessSpawns()),
			row("listed", claudeSpawns = listOf("windows"), copilotSpawns = listOf("host")),
			row("oldest", copilotSpawns = listOf("host")),
		)

		assertEquals(agents(SessionHarness.COPILOT), registry.agentsOn("mapped", "host"))
		assertEquals(agents(SessionHarness.CLAUDE, SessionHarness.COPILOT), registry.agentsOn("mapped", "windows"))
		assertEquals(agents(), registry.agentsOn("unprobed", "host"))
		assertEquals(agents(SessionHarness.COPILOT), registry.agentsOn("listed", "host"))
		assertEquals(agents(SessionHarness.CLAUDE), registry.agentsOn("listed", "windows"))
		assertEquals(agents(SessionHarness.CLAUDE, SessionHarness.COPILOT), registry.agentsOn("oldest", "host"))
		assertEquals(agents(SessionHarness.CLAUDE), registry.agentsOn("oldest", "windows"))
		assertEquals(agents(SessionHarness.COPILOT), registry.agentsOnSession("d.mapped.host.demo"))
	}
}
