package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The create dialog's Claude or Copilot pick, and the install macros each spawn point offers. */
class SessionHarnessPickTest {
	private val projects = listOf("host", "windows", "recipe-app")

	private fun agents(claude: Set<String>, copilot: Set<String>): (String) -> SpawnAgents = { project ->
		SpawnAgents(claude = project in claude, copilot = project in copilot)
	}

	@Test
	fun `the pick shows only when the Gateway has a project for each agent`() {
		assertTrue(offersHarnessPick(projects, agents(setOf("host", "recipe-app"), setOf("host"))))
		assertFalse(offersHarnessPick(projects, agents(setOf("host", "recipe-app"), emptySet())))
		assertFalse(offersHarnessPick(listOf("host"), agents(emptySet(), setOf("host"))))
	}

	@Test
	fun `each pick offers the projects whose spawn point has that agent`() {
		val held = agents(setOf("host", "recipe-app"), setOf("host", "windows"))

		assertEquals(listOf("host", "recipe-app"), harnessProjects(projects, held, SessionHarness.CLAUDE))
		assertEquals(listOf("host", "windows"), harnessProjects(projects, held, SessionHarness.COPILOT))
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
