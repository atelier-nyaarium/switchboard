package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The create dialog's Claude or Copilot pick, and the install macros each spawn point offers. */
class SessionHarnessPickTest {
	private val projects = listOf("host", "windows", "recipe-app")

	private fun agents(claude: Set<String>, copilot: Set<String>): (String) -> SpawnAgents = { project ->
		SpawnAgents(claude = project in claude, copilot = project in copilot)
	}

	@Test
	fun `a project is offered when its spawn point runs any agent`() {
		val held = agents(setOf("recipe-app"), setOf("windows"))

		assertEquals(listOf("windows", "recipe-app"), spawnableProjects(projects, held))
	}

	@Test
	fun `a picked project offers the agents its spawn point runs, and keeps the held one when it can`() {
		val both = harnessesOf(SpawnAgents(claude = true, copilot = true))
		val copilotOnly = harnessesOf(SpawnAgents(claude = false, copilot = true))

		assertEquals(listOf(SessionHarness.CLAUDE, SessionHarness.COPILOT), both)
		assertEquals(listOf(SessionHarness.COPILOT), copilotOnly)
		assertEquals(SessionHarness.COPILOT, harnessAfterPick(SessionHarness.COPILOT, both))
		assertEquals(SessionHarness.COPILOT, harnessAfterPick(SessionHarness.CLAUDE, copilotOnly))
		assertNull(harnessAfterPick(SessionHarness.CLAUDE, emptyList()))
	}

	@Test
	fun `only Copilot names itself on the wire`() {
		assertNull(SessionHarness.CLAUDE.wire)
		assertEquals("copilot", SessionHarness.COPILOT.wire)
	}

	@Test
	fun `each install pair shows where its agent is, and both where neither is`() {
		assertEquals(PALETTE_SHELL_CLAUDE, shellMacros(SpawnAgents(claude = true, copilot = false)))
		assertEquals(PALETTE_SHELL_COPILOT, shellMacros(SpawnAgents(claude = false, copilot = true)))
		assertEquals(PALETTE_SHELL_CLAUDE + PALETTE_SHELL_COPILOT, shellMacros(SpawnAgents(claude = true, copilot = true)))
		assertEquals(PALETTE_SHELL_CLAUDE + PALETTE_SHELL_COPILOT, shellMacros(SpawnAgents(claude = false, copilot = false)))
	}

	@Test
	fun `a devcontainer runs Claude, and an older Gateway reads as Claude on every host spawn point`() {
		val registry = GatewayRegistry()

		assertEquals(SpawnAgents(claude = true, copilot = false), registry.agentsOn("mikan", "recipe-app"))
		assertEquals(SpawnAgents(claude = true, copilot = false), registry.agentsOn("mikan", "host"))
	}
}
