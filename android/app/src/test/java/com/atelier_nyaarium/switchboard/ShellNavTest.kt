package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.saveable.SaverScope
import com.atelier_nyaarium.switchboard.assistant.AutomationSlot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellNavTest {
	private val features = DrawerFeatures(board = true, vault = true)
	private val views = conversationViews(terminal = true, assistant = false)
	private val offered = rootViews(features)
	private val facts = ArrivalFacts(views, stuckAtLogin = false)
	private val a = "home.sakura.host.aaa"
	private val b = "home.sakura.host.bbb"

	private fun backFacts(
		drawerOpen: Boolean = false,
		editorOpen: Boolean = false,
		overlayOpen: Boolean = false,
		locked: Boolean = false,
		booted: Boolean = true,
	) = BackFacts(editorOpen, locked, overlayOpen, booted, drawerOpen, offered, views)

	/** Drives Back until the system handles it, recording layers. */
	private fun backAll(start: ShellNav, facts: BackFacts = backFacts()): List<BackLayer> {
		var nav = start
		val layers = mutableListOf<BackLayer>()
		while (true) {
			val layer = backLayer(nav, facts) ?: return layers
			layers += layer
			nav = nav.back(layer, facts, provisioned = true)
		}
	}

	private fun screenOf(nav: ShellNav) = shellScreen(nav, locked = false, overlayOpen = false, booted = true)

	@Test
	fun `the Assistant pages draw over what opened them, Back walks Setup, Entry, Add, then beneath, and an arrival clears them`() {
		val setup = AssistantPage.Setup("sakura", "kasa")
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts).openAssistantPage(setup)
		val walked = generateSequence(open) { nav ->
			backLayer(nav, backFacts())?.takeIf { it == BackLayer.ASSISTANT_PAGE }?.let { nav.back(it, backFacts(), provisioned = true) }
		}.map { it.assistantPage }.toList()

		assertEquals(ShellScreen.ASSISTANT_PAGE, screenOf(open))
		assertEquals(listOf(setup, AssistantPage.Entry("sakura", "kasa"), AssistantPage.Add, null), walked)
		assertEquals(List(3) { BackLayer.ASSISTANT_PAGE } + BackLayer.CONVERSATION, backAll(open))
		assertEquals(AssistantPage.Settings, assistantPageBack(AssistantPage.Safety))
		assertEquals(
			listOf(null, null, null),
			listOf(
				AssistantPage.Source("sakura", "github"),
				AssistantPage.Device("sakura", "aa:bb:cc:dd:ee:01"),
				AssistantPage.AutomationEditor("sakura", AutomationSlot.New),
			).map(::assistantPageBack),
		)
		assertFalse(open.showsAssistant(assistantOpen = false, screen = ShellScreen.LOCK))
		val left = open.arrive(b, Arrival.OUTSIDE, facts)
		assertNull(left.assistantPage)
		assertFalse(left.showsAssistant(assistantOpen = false, screen = ShellScreen.CONVERSATION))
	}

	@Test
	fun `a pick inside a session lands over it filtered, the chip clears it, and Back returns to the session`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts).showView(ConversationView.FILES)
		val picked = open.pick(RootView.RUNBOOKS, assistantOpen = false)
		val cleared = picked.filter(false)

		assertEquals(ShellScreen.CONVERSATION, screenOf(open))
		assertEquals(RootView.SESSIONS, open.menuShown(offered, assistantOpen = false))
		assertEquals(ShellScreen.ROOT, screenOf(picked))
		assertEquals(OverNav(RootView.RUNBOOKS, filtered = true), picked.over)
		assertEquals(RootView.RUNBOOKS, picked.rootShown(offered))
		assertEquals(RootView.RUNBOOKS, picked.menuShown(offered, assistantOpen = false))
		assertEquals(OverNav(RootView.RUNBOOKS, filtered = false), cleared.over)
		assertEquals(picked.over, cleared.filter(true).over)
		assertEquals(OverNav(RootView.POLICIES, filtered = true), cleared.pick(RootView.POLICIES, assistantOpen = false).over)
		assertEquals(listOf(BackLayer.OVER, BackLayer.VIEW, BackLayer.CONVERSATION), backAll(cleared))
		assertEquals(open, cleared.back(BackLayer.OVER, backFacts(), provisioned = true))
		assertEquals(BackLayer.DRAWER, backLayer(picked, backFacts(drawerOpen = true)))
	}

	@Test
	fun `Sessions and Assistant leave the session, Sources and Automations take no filter, and the root keeps its own view`() {
		val open = ShellNav().showRoot(RootView.BACKLOG).arrive(a, Arrival.OUTSIDE, facts)

		assertEquals(ShellNav(root = RootView.SESSIONS, generation = 1), open.pick(RootView.SESSIONS, assistantOpen = false))
		assertEquals(ShellNav(root = RootView.ASSISTANT, generation = 1), open.pick(RootView.ASSISTANT, assistantOpen = false))
		assertEquals(OverNav(RootView.SOURCES, filtered = false), open.pick(RootView.SOURCES, assistantOpen = false).over)
		assertEquals(OverNav(RootView.AUTOMATIONS, filtered = false), open.pick(RootView.AUTOMATIONS, assistantOpen = false).over)
		assertEquals(RootView.BACKLOG, open.pick(RootView.VAULT, assistantOpen = false).root)
		assertEquals(ShellNav(root = RootView.VAULT), ShellNav().pick(RootView.VAULT, assistantOpen = false))
	}

	@Test
	fun `the assistant's session filters nothing, and Assistant returns to its chat`() {
		val open = ShellNav().arriveAt(a, assistant = true, Arrival.OUTSIDE, facts)
		val picked = open.pick(RootView.BACKLOG, assistantOpen = true)

		assertEquals(RootView.ASSISTANT, open.menuShown(offered, assistantOpen = true))
		assertEquals(OverNav(RootView.BACKLOG, filtered = false), picked.over)
		assertFalse(picked.showsAssistant(assistantOpen = true, screen = screenOf(picked)))
		assertEquals(open, picked.pick(RootView.ASSISTANT, assistantOpen = true))
		assertEquals(ShellNav(root = RootView.SESSIONS, generation = 1), picked.pick(RootView.SESSIONS, assistantOpen = true))
	}

	@Test
	fun `an arrival, a leave and a view no longer offered each drop a pick, and a saved entry returns to the session`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts)
		val picked = open.pick(RootView.BACKLOG, assistantOpen = false)

		assertNull(picked.arrive(b, Arrival.TAB, facts).over)
		assertNull(picked.forgot(a).over)
		assertEquals(open, picked.offering(rootViews(DrawerFeatures(board = false, vault = true))))
		assertEquals(picked, picked.offering(offered))
		assertEquals(open, picked.boardSaved())
		assertEquals(RootView.SESSIONS, ShellNav().showRoot(RootView.BACKLOG).boardSaved().root)
	}

	@Test
	fun `a page's exit to a root view closes it, over a session or at the root`() {
		val source = AssistantPage.Source("sakura", "github")
		val atRoot = ShellNav().showRoot(RootView.SOURCES).openAssistantPage(source)
		val inSession = ShellNav().arrive(a, Arrival.OUTSIDE, facts).openAssistantPage(source)

		assertEquals(ShellNav(root = RootView.AUTOMATIONS), atRoot.toRoot(RootView.AUTOMATIONS, assistantOpen = false))
		assertEquals(
			OverNav(RootView.AUTOMATIONS, filtered = false),
			inSession.toRoot(RootView.AUTOMATIONS, assistantOpen = false).also { assertNull(it.assistantPage) }.over,
		)
		assertEquals(ShellNav(root = RootView.SOURCES), atRoot.closeAssistantPage())
	}

	@Test
	fun `only the assistant's own pages and a page over its chat count as the assistant shown, and every page reads the home`() {
		val device = ShellNav().showRoot(RootView.SOURCES).openAssistantPage(AssistantPage.Device("sakura", "aa:bb:cc:dd:ee:01"))
		val safety = ShellNav().openAssistantPage(AssistantPage.Safety)

		assertFalse(device.showsAssistant(assistantOpen = false, screen = ShellScreen.ASSISTANT_PAGE))
		assertTrue(device.showsAssistant(assistantOpen = true, screen = ShellScreen.ASSISTANT_PAGE))
		assertTrue(safety.showsAssistant(assistantOpen = false, screen = ShellScreen.ASSISTANT_PAGE))
		assertTrue(device.readsHome(assistantOpen = false, screen = ShellScreen.ASSISTANT_PAGE, offered = offered))
	}

	@Test
	fun `Sources and Automations read the home as the assistant's own screens do`() {
		val sources = ShellNav().showRoot(RootView.SOURCES)
		val over = ShellNav().arrive(a, Arrival.OUTSIDE, facts).pick(RootView.AUTOMATIONS, assistantOpen = false)

		assertTrue(sources.readsHome(assistantOpen = false, screen = ShellScreen.ROOT, offered = offered))
		assertFalse(sources.showsAssistant(assistantOpen = false, screen = ShellScreen.ROOT))
		assertTrue(over.readsHome(assistantOpen = false, screen = screenOf(over), offered = offered))
		assertFalse(ShellNav().showRoot(RootView.VAULT).readsHome(assistantOpen = false, screen = ShellScreen.ROOT, offered = offered))
		assertTrue(ShellNav().showRoot(RootView.ASSISTANT).readsHome(assistantOpen = false, screen = ShellScreen.ROOT, offered = offered))
		assertFalse(sources.readsHome(assistantOpen = false, screen = ShellScreen.SETTINGS, offered = offered))
	}

	@Test
	fun `every Assistant page survives recreation`() {
		val pages = listOf(
			AssistantPage.Settings,
			AssistantPage.Location,
			AssistantPage.Features,
			AssistantPage.Safety,
			AssistantPage.Source("sakura", "github"),
			AssistantPage.AutomationEditor("sakura", AutomationSlot.Held("reviews")),
			AssistantPage.AutomationEditor("sakura", AutomationSlot.New),
			AssistantPage.Add,
			AssistantPage.Entry("sakura", "kasa"),
			AssistantPage.Device("sakura", "aa:bb:cc:dd:ee:01"),
		)

		val scope = SaverScope { true }
		val restored = pages.map { page ->
			val nav = ShellNav(root = RootView.ASSISTANT, assistantPage = page)
			ShellNavSaver.restore(with(ShellNavSaver) { scope.save(nav) }!!)
		}

		assertEquals(pages.map { ShellNav(root = RootView.ASSISTANT, assistantPage = it) }, restored)
		assertEquals(pages.size, pages.map(::pageKey).toSet().size)
	}

	@Test
	fun `a tab switch keeps the view and re-snaps, a closed tab keeps it quietly, and a fresh open starts on chat`() {
		val opened = ShellNav().arrive(a, Arrival.OUTSIDE, facts)
		val switched = opened.showView(ConversationView.FILES).arrive(b, Arrival.TAB, facts)
		val closed = switched.arrive(a, Arrival.CLOSED_TAB, facts)
		val reopened = closed.leave().arrive(b, Arrival.OUTSIDE, facts)

		assertEquals(ConversationView.FILES, switched.conversation?.view)
		assertEquals(ConversationView.FILES, closed.conversation?.view)
		assertEquals(ConversationView.CHAT, reopened.conversation?.view)
		assertEquals(listOf(1, 2, 2, 3), listOf(opened, switched, closed, reopened).map { it.generation })
	}

	@Test
	fun `a ref's exit lands on its place, and Back walks Files, then the view, then leaves`() {
		val browsing = ShellNav().arrive(a, Arrival.OUTSIDE, facts).showView(ConversationView.FILES)
			.pushFiles(WorkspacePlace.Tree("src"))
		val asked = browsing.arrive(a, Arrival.FILES_ASKED, facts, WorkspacePlace.Windows)

		assertEquals(listOf(WORKSPACE_ROOT, WorkspacePlace.Windows), asked.conversation?.files)
		assertEquals(0, asked.generation - browsing.generation)
		assertEquals(
			listOf(BackLayer.FILES, BackLayer.VIEW, BackLayer.CONVERSATION),
			backAll(asked),
		)
	}

	// Each drill-in is a place, so Back unwinds the walk before it leaves Files.
	@Test
	fun `Back walks a drill-in one place at a time before leaving Files`() {
		val detail = WorkspacePlace.Detail("lexicon typescript src/a.ts f().", "src/a.ts", "f")
		val refs = WorkspacePlace.Facet(detail.symbolId, detail.module, FacetEntry.REFERENCES, FacetSubject("f"))
		val reached = detail.copy(reached = Reached("f", "Type", 99))
		val uses = refs.copy(entry = FacetEntry.USES)
		val drilled = ShellNav().arrive(a, Arrival.OUTSIDE, facts).showView(ConversationView.FILES)
			.pushFiles(WorkspacePlace.Outline("src/a.ts"))
			.pushFiles(detail)
			.pushFiles(refs)
			.pushFiles(reached)
			.pushFiles(uses)

		assertEquals(
			listOf(
				BackLayer.FILES,
				BackLayer.FILES,
				BackLayer.FILES,
				BackLayer.FILES,
				BackLayer.FILES,
				BackLayer.VIEW,
				BackLayer.CONVERSATION,
			),
			backAll(drilled),
		)
	}

	@Test
	fun `another session's Files start at the root`() {
		val deep = ShellNav().arrive(a, Arrival.OUTSIDE, facts).pushFiles(WorkspacePlace.Tree("src"))

		assertEquals(listOf(WORKSPACE_ROOT), deep.arrive(b, Arrival.TAB, facts).conversation?.files)
		assertEquals(listOf(WORKSPACE_ROOT, WorkspacePlace.Tree("src")), deep.arrive(a, Arrival.TAB, facts).conversation?.files)
	}

	@Test
	fun `an editor, an overlay, settings and an open drawer each outrank the Files stack`() {
		val deep = ShellNav().arrive(a, Arrival.OUTSIDE, facts).showView(ConversationView.FILES)
			.pushFiles(WorkspacePlace.Tree("src"))

		assertEquals(BackLayer.EDITOR, backLayer(deep, backFacts(editorOpen = true, drawerOpen = true)))
		assertEquals(BackLayer.OVERLAY, backLayer(deep, backFacts(overlayOpen = true, drawerOpen = true)))
		assertEquals(BackLayer.SETTINGS, backLayer(deep.openSettings(), backFacts(drawerOpen = true)))
		assertEquals(BackLayer.DRAWER, backLayer(deep, backFacts(drawerOpen = true)))
		assertEquals(BackLayer.FILES, backLayer(deep, backFacts()))
	}

	@Test
	fun `nothing navigates behind the lock or before boot, and a root view steps back to sessions`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts)

		assertNull(backLayer(open, backFacts(locked = true)))
		assertNull(backLayer(open, backFacts(locked = true, editorOpen = true)))
		assertNull(backLayer(open, backFacts(booted = false)))
		assertEquals(BackLayer.SETTINGS, backLayer(open.openSettings(), backFacts(booted = false)))
		assertEquals(listOf(BackLayer.ROOT_VIEW), backAll(ShellNav().showRoot(RootView.VAULT)))
	}

	@Test
	fun `settings Back returns through Domain and Trust once provisioned, and closes from the hub`() {
		assertEquals(SettingsRoute.NETWORKS, settingsBack(SettingsRoute.FEDERATION, provisioned = true))
		assertEquals(SettingsRoute.HUB, settingsBack(SettingsRoute.FEDERATION, provisioned = false))
		assertEquals(SettingsRoute.HUB, settingsBack(SettingsRoute.SECURITY, provisioned = true))
		// Provisioned-only routes resolve to the hub before provisioning.
		assertNull(settingsBack(SettingsRoute.SECURITY, provisioned = false))
		assertEquals(
			listOf(BackLayer.SETTINGS, BackLayer.SETTINGS, BackLayer.SETTINGS),
			backAll(ShellNav().openSettings(SettingsRoute.FEDERATION)),
		)
	}

	// The render and Back read this one order, so what Back closes is what is drawn.
	@Test
	fun `the lock hides everything, an overlay hides settings, and settings open before boot`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts).openSettings()

		assertEquals(ShellScreen.LOCK, shellScreen(open, locked = true, overlayOpen = true, booted = true))
		assertEquals(ShellScreen.OVERLAY, shellScreen(open, locked = false, overlayOpen = true, booted = true))
		assertEquals(ShellScreen.SETTINGS, shellScreen(open, locked = false, overlayOpen = false, booted = false))
		assertEquals(ShellScreen.BOOT, shellScreen(open.closeSettings(), locked = false, overlayOpen = false, booted = false))
		assertEquals(ShellScreen.CONVERSATION, shellScreen(open.closeSettings(), locked = false, overlayOpen = false, booted = true))
		assertEquals(ShellScreen.ROOT, shellScreen(open.closeSettings().leave(), locked = false, overlayOpen = false, booted = true))
	}

	@Test
	fun `forgetting another session leaves the open one alone`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts)

		assertEquals(open, open.forgot(b))
		assertNull(open.forgot(a).conversation)
	}
}
