package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private fun session(address: String) = testTeam(address)

class WorkspaceNavTest {
	private val outline = WorkspacePlace.Outline("src/a.ts")

	@Test
	fun `the root never pops, so the tab cannot show nothing`() {
		assertEquals(listOf(WORKSPACE_ROOT), popPlace(listOf(WORKSPACE_ROOT)))
		assertEquals(listOf(WORKSPACE_ROOT), popPlace(emptyList()))
	}

	@Test
	fun `a step back returns the place before it`() {
		val stack = pushPlace(listOf(WORKSPACE_ROOT), outline)

		assertEquals(outline, placeOf(stack))
		assertEquals(WORKSPACE_ROOT, placeOf(popPlace(stack)))
	}

	// Pushing where we already are would make Back need pressing twice for one step.
	@Test
	fun `arriving where we already are is not a step`() {
		val stack = pushPlace(listOf(WORKSPACE_ROOT), outline)

		assertEquals(stack, pushPlace(stack, outline))
	}

	@Test
	fun `a title names the place, and a directory keeps its whole path`() {
		assertEquals("Files", placeTitle(WORKSPACE_ROOT))
		// The leaf alone loses where in the tree this is.
		assertEquals("src/gateway", placeTitle(WorkspacePlace.Tree("src/gateway")))
		assertEquals("a.ts", placeTitle(outline))
		assertEquals("routineRefusal", placeTitle(WorkspacePlace.Detail("lexicon typescript src/a.ts f().", "routineRefusal")))
	}

	@Test
	fun `a child of the root carries no leading separator`() {
		assertEquals("src", childPath("", "src"))
		assertEquals("src/a.ts", childPath("src", "a.ts"))
	}

	// A spawn point has no plugin of its own, so offering it would offer a read nothing answers.
	@Test
	fun `only session addresses are offered`() {
		val teams = listOf(session("home.sakura.host"), session("home.sakura.host.bbb"), session("home.sakura.host.aaa"))

		assertEquals(
			listOf("home.sakura.host.aaa", "home.sakura.host.bbb"),
			workspaceSessions(teams).map { it.name },
		)
	}

	// Nothing picked is not a state worth showing: the field names whichever one is being read.
	@Test
	fun `nothing picked reads the first, and a pick reads that one`() {
		val sessions = listOf(session("home.sakura.host.aaa"), session("home.sakura.host.bbb"))

		assertEquals("home.sakura.host.aaa", pickedSession(sessions, null)?.name)
		assertEquals("home.sakura.host.bbb", pickedSession(sessions, "home.sakura.host.bbb")?.name)
		assertNull(pickedSession(emptyList(), null))
	}

	// A pick the roster dropped is not kept, or the tab reads a workspace that is gone.
	@Test
	fun `a pick the roster no longer holds falls back rather than sticking`() {
		val sessions = listOf(session("home.sakura.host.aaa"), session("home.sakura.host.bbb"))

		assertEquals("home.sakura.host.aaa", pickedSession(sessions, "home.sakura.host.ccc")?.name)
	}

	@Test
	fun `a target names both the gateway to ask and the session to ask about`() {
		assertEquals(
			WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa"),
			targetOf(session("home.sakura.host.aaa")),
		)
	}
}
