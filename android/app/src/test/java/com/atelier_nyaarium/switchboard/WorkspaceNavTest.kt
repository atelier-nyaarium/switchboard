package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
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
		assertEquals("a.ts", placeTitle(WorkspacePlace.Raw("src/a.ts")))
		assertEquals("Windows", placeTitle(WorkspacePlace.Windows))
		assertEquals("routineRefusal", placeTitle(WorkspacePlace.Detail("lexicon typescript src/a.ts f().", "routineRefusal")))
	}

	@Test
	fun `a child of the root carries no leading separator`() {
		assertEquals("src", childPath("", "src"))
		assertEquals("src/a.ts", childPath("src", "a.ts"))
	}

	// A request opens a conversation, so one for a session that is gone must not open anything.
	@Test
	fun `a request waits for the roster, shows on its own session, and is dropped once it is gone`() {
		val sessions = listOf(session("home.sakura.host.aaa"), session("home.sakura.host.bbb"))

		assertEquals(RequestStanding.Show, standingOf(sessions, true, "home.sakura.host.bbb"))
		assertEquals(RequestStanding.Wait, standingOf(emptyList(), false, "home.sakura.host.bbb"))
		assertEquals(RequestStanding.Drop, standingOf(sessions, true, "home.sakura.host.ccc"))
		assertEquals(RequestStanding.Drop, standingOf(emptyList(), true, "home.sakura.host.bbb"))
	}

	// A spawn point has no plugin of its own, so a request naming one would ask what nothing answers.
	@Test
	fun `a spawn point holds no workspace`() {
		val spawn = session("home.sakura.host")

		assertEquals(RequestStanding.Drop, standingOf(listOf(spawn), true, "home.sakura.host"))
	}

	@Test
	fun `a target names both the gateway to ask and the session to ask about`() {
		assertEquals(
			WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa"),
			targetOf(session("home.sakura.host.aaa")),
		)
	}
}
