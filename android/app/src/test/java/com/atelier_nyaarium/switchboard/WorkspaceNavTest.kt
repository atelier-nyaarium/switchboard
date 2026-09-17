package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private fun session(address: String) = testTeam(address)

class WorkspaceNavTest {
	private val outline = WorkspacePlace.Outline("src/a.ts")

	private val detail = WorkspacePlace.Detail("lexicon typescript src/a.ts f().", "src/a.ts", "f")

	private fun facet(entry: FacetEntry) =
		WorkspacePlace.Facet(detail.symbolId, detail.module, entry, FacetSubject("f", "function", 4))

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
	fun `a title names the place, and a detail names its symbol`() {
		assertEquals("Files", placeTitle(WORKSPACE_ROOT))
		assertEquals("src/gateway", placeTitle(WorkspacePlace.Tree("src/gateway")))
		assertEquals("a.ts", placeTitle(outline))
		assertEquals("a.ts", placeTitle(WorkspacePlace.Raw("src/a.ts")))
		assertEquals("Windows", placeTitle(WorkspacePlace.Windows))
		assertEquals("f", placeTitle(detail))
		assertEquals("References of f", placeTitle(facet(FacetEntry.USED_BY)))
		assertEquals("Hierarchy of f", placeTitle(facet(FacetEntry.HIERARCHY)))
	}

	@Test
	fun `a drill-in steps one place at a time, and Back returns one at a time`() {
		val refs = facet(FacetEntry.REFERENCES)
		val reached = detail.copy(reached = Reached("f", "Type", 99))
		val walked = listOf(WORKSPACE_ROOT, outline, detail, refs, reached)

		assertEquals(reached, placeOf(walked))
		assertEquals(refs, placeOf(popPlace(walked)))
		assertEquals(detail, placeOf(popPlace(popPlace(walked))))
		assertEquals(outline, placeOf(popPlace(popPlace(popPlace(walked)))))
	}

	// Otherwise Back from the use's detail would land past the list it was reached through.
	@Test
	fun `the same detail reached from a use is its own step`() {
		val reached = detail.copy(reached = Reached("g", "Call", 12))
		val stack = listOf(WORKSPACE_ROOT, detail)

		assertEquals(stack + reached, pushPlace(stack, reached))
		assertEquals(stack, pushPlace(stack, detail))
	}

	@Test
	fun `the back line names the place Back returns to`() {
		val refs = facet(FacetEntry.REFERENCES)

		assertEquals("a.ts", backTitle(listOf(WORKSPACE_ROOT, outline, detail)))
		assertEquals("f", backTitle(listOf(WORKSPACE_ROOT, outline, detail, refs)))
		assertEquals("References of f", backTitle(listOf(WORKSPACE_ROOT, outline, detail, refs, detail)))
		assertEquals("Files", backTitle(listOf(WORKSPACE_ROOT)))
	}

	// Two places sharing a key would hand Back the other screen's scroll and chosen chips.
	@Test
	fun `each place on a stack keeps its own screen state under its own key`() {
		val reached = detail.copy(reached = Reached("g", "Type", 9))
		val stack = listOf(
			WORKSPACE_ROOT,
			outline,
			WorkspacePlace.Raw("src/a.ts"),
			detail,
			reached,
			facet(FacetEntry.REFERENCES),
			facet(FacetEntry.USED_BY),
			WorkspacePlace.Windows,
		)

		assertEquals(stack.size, stack.map { placeKey(it) }.distinct().size)
		// A key minted fresh each call separates everything and restores nothing.
		for (place in stack) assertEquals(placeKey(place), placeKey(place))
		assertEquals(placeKey(reached), placeKey(detail.copy(reached = Reached("g", "Type", 9))))
	}

	// Only the history screen shows the file's own strip, so only it holds that read.
	@Test
	fun `the history facet names the file whose history is read beside it, and no other facet does`() {
		assertEquals(detail.module, stripModule(facet(FacetEntry.HISTORY)))
		assertTrue(FacetEntry.entries.filter { it != FacetEntry.HISTORY }.all { stripModule(facet(it)) == null })
	}

	@Test
	fun `a child of the root carries no leading separator, and its parent is the root`() {
		assertEquals("src", childPath("", "src"))
		assertEquals("src/a.ts", childPath("src", "a.ts"))
		assertEquals("", parentPath("src"))
		assertEquals("src", parentPath("src/a.ts"))
	}

	@Test
	fun `a jump returns to a folder on the stack, and steps onto one that is not`() {
		val src = WorkspacePlace.Tree("src")
		val shared = WorkspacePlace.Tree("src/shared")
		val drilled = listOf(WORKSPACE_ROOT, src, shared, WorkspacePlace.Outline("src/shared/a.ts"))

		assertEquals(listOf(WORKSPACE_ROOT, src), jumpPlace(drilled, src))
		assertEquals(listOf(WORKSPACE_ROOT), jumpPlace(drilled, WORKSPACE_ROOT))

		val arrived = listOf(WORKSPACE_ROOT, WorkspacePlace.Outline("src/shared/a.ts"))
		assertEquals(arrived + shared, jumpPlace(arrived, shared))
	}

	@Test
	fun `crumbs name the project, then each folder with the path it opens`() {
		assertEquals(
			listOf(Crumb("switchboard", ""), Crumb("src", "src"), Crumb("gateway", "src/gateway")),
			crumbsOf("~/projects/switchboard", "src/gateway"),
		)
		assertEquals(crumbsOf("~/projects/switchboard", "src/gateway"), crumbsOf("~/projects/switchboard", "src//gateway/"))
		assertEquals("~/projects/", rootPrefix("~/projects/switchboard"))
		// An older plugin names no root.
		assertEquals(listOf(Crumb("Files", "")), crumbsOf(null, ""))
		assertEquals("", rootPrefix(null))
		assertEquals("Files", projectName("/"))
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
