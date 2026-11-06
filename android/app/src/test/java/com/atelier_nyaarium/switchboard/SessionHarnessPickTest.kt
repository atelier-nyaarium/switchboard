package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The create dialog's Claude or Copilot pick, and the projects each one offers. */
class SessionHarnessPickTest {
	private val projects = listOf("host", "windows", "recipe-app")

	@Test
	fun `the pick shows only when a project can run Copilot`() {
		assertTrue(offersHarnessPick(projects, listOf("host")))
		assertFalse(offersHarnessPick(projects, emptyList()))
		assertFalse(offersHarnessPick(listOf("recipe-app"), listOf("host")))
	}

	@Test
	fun `Copilot narrows the projects to its spawn points, Claude offers them all`() {
		val copilot = listOf("host", "windows")

		assertEquals(projects, harnessProjects(projects, copilot, SessionHarness.CLAUDE))
		assertEquals(listOf("host", "windows"), harnessProjects(projects, copilot, SessionHarness.COPILOT))
	}

	@Test
	fun `only Copilot names itself on the wire`() {
		assertNull(SessionHarness.CLAUDE.wire)
		assertEquals("copilot", SessionHarness.COPILOT.wire)
	}
}
