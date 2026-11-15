package com.atelier_nyaarium.switchboard

import androidx.compose.runtime.saveable.SaverScope
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

	private fun shellFacts(
		drawerOpen: Boolean = false,
		editorOpen: Boolean = false,
		overlayOpen: Boolean = false,
		locked: Boolean = false,
		booted: Boolean = true,
		assistantOpen: Boolean = false,
	) = ShellFacts(editorOpen, locked, overlayOpen, booted, drawerOpen, offered, views, assistantOpen)

	private fun everyShellFacts(assistantOpen: Boolean): List<ShellFacts> {
		val both = listOf(false, true)
		return both.flatMap { drawer ->
			both.flatMap { editor ->
				both.flatMap { overlay ->
					both.flatMap { locked -> both.map { booted -> shellFacts(drawer, editor, overlay, locked, booted, assistantOpen) } }
				}
			}
		}
	}

	private fun drawn(nav: ShellNav, facts: ShellFacts = shellFacts()) = nav.drawn(facts)

	private fun conversation(nav: ShellNav) = drawn(nav) as Drawn.Conversation

	private fun backAll(start: ShellNav, facts: ShellFacts = shellFacts()): List<BackLayer> {
		var nav = start
		val layers = mutableListOf<BackLayer>()
		while (true) {
			val layer = backLayer(nav, facts) ?: return layers
			layers += layer
			nav = nav.back(layer, facts, provisioned = true)
		}
	}

	@Test
	fun `pages draw over what opened them, Back pops each to its opener, then beneath, and an arrival clears them`() {
		val entry = ShellPage.Entry("sakura", "kasa")
		val setup = ShellPage.Setup("sakura", "kasa")
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts).push(ShellPage.Add).push(entry).push(setup)
		val walked = generateSequence(open) { nav ->
			backLayer(nav, shellFacts())?.takeIf { it == BackLayer.PAGE }?.let { nav.back(it, shellFacts(), provisioned = true) }
		}.map { (drawn(it) as? Drawn.Page)?.page }.toList()

		assertEquals(listOf(setup, entry, ShellPage.Add, null), walked)
		assertEquals(List(3) { BackLayer.PAGE } + BackLayer.CONVERSATION, backAll(open))
		assertEquals(open, open.push(setup))

		val device = ShellPage.Device("sakura", "aa:bb:cc:dd:ee:01")
		val replaced = open.replaceTop(device)
		assertEquals(Drawn.Page(device, overAssistant = false), drawn(replaced))
		assertEquals(Drawn.Page(entry, overAssistant = false), drawn(replaced.back(BackLayer.PAGE, shellFacts(), provisioned = true)))

		val fromSources = ShellNav().showRoot(RootView.SOURCES).push(entry)
		assertEquals(Drawn.Root(RootView.SOURCES, null), drawn(fromSources.back(BackLayer.PAGE, shellFacts(), provisioned = true)))

		assertFalse(showsAssistant(drawn(open, shellFacts(locked = true))))
		val left = open.arrive(b, Arrival.OUTSIDE, facts)
		assertEquals(b, conversation(left).team)
		assertFalse(showsAssistant(drawn(left)))
	}

	@Test
	fun `a pick inside a session lands over it filtered, the chip clears it, and Back returns to the session`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts).showView(ConversationView.FILES)
		val picked = open.pick(RootView.RUNBOOKS, assistantOpen = false)
		val cleared = picked.filter(false)

		assertEquals(ShellScreen.CONVERSATION, drawn(open).kind)
		assertEquals(RootView.SESSIONS, menuShown(drawn(open)))
		assertEquals(Drawn.Root(RootView.RUNBOOKS, Over(a, filterable = true, ViewScope.Session(a))), drawn(picked))
		assertEquals(RootView.RUNBOOKS, menuShown(drawn(picked)))
		assertEquals(Drawn.Root(RootView.RUNBOOKS, Over(a, filterable = true, ViewScope.Everything)), drawn(cleared))
		assertEquals(drawn(picked), drawn(cleared.filter(true)))
		assertEquals(
			Drawn.Root(RootView.POLICIES, Over(a, filterable = true, ViewScope.Session(a))),
			drawn(cleared.pick(RootView.POLICIES, assistantOpen = false)),
		)
		assertEquals(listOf(BackLayer.OVER, BackLayer.VIEW, BackLayer.CONVERSATION), backAll(cleared))
		assertEquals(open, cleared.back(BackLayer.OVER, shellFacts(), provisioned = true))
		assertEquals(BackLayer.DRAWER, backLayer(picked, shellFacts(drawerOpen = true)))
	}

	@Test
	fun `over a pick, what is drawn and Back do not depend on the root beneath`() {
		for (beneath in RootView.entries) {
			for (view in offered - RootView.SESSIONS - RootView.ASSISTANT) {
				for (assistantOpen in listOf(false, true)) {
					val base = ShellNav().arrive(a, Arrival.OUTSIDE, facts).pick(view, assistantOpen)
					val other = ShellNav().showRoot(beneath).arrive(a, Arrival.OUTSIDE, facts).pick(view, assistantOpen)
					for (f in everyShellFacts(assistantOpen)) {
						assertEquals(base.drawn(f), other.drawn(f))
						assertEquals(backLayer(base, f), backLayer(other, f))
					}
				}
			}
		}
	}

	@Test
	fun `Back from a pick, then from the session, lands each view beneath`() {
		for (beneath in RootView.entries) {
			val picked = ShellNav().showRoot(beneath).arrive(a, Arrival.OUTSIDE, facts).pick(RootView.BACKLOG, assistantOpen = false)
			val left = picked.back(BackLayer.OVER, shellFacts(), provisioned = true).back(BackLayer.CONVERSATION, shellFacts(), provisioned = true)

			assertEquals(Drawn.Root(beneath, null), drawn(left))
		}
	}

	@Test
	fun `Sessions and Assistant leave the session, Sources and Automations take no filter, and the root keeps its own view`() {
		val open = ShellNav().showRoot(RootView.BACKLOG).arrive(a, Arrival.OUTSIDE, facts)
		val noFilter = Over(a, filterable = false, ViewScope.Everything)

		assertEquals(Drawn.Root(RootView.SESSIONS, null), drawn(open.pick(RootView.SESSIONS, assistantOpen = false)))
		assertEquals(Drawn.Root(RootView.ASSISTANT, null), drawn(open.pick(RootView.ASSISTANT, assistantOpen = false)))
		assertNull(open.pick(RootView.ASSISTANT, assistantOpen = false).heldTeam)
		assertEquals(Drawn.Root(RootView.SOURCES, noFilter), drawn(open.pick(RootView.SOURCES, assistantOpen = false)))
		assertEquals(Drawn.Root(RootView.AUTOMATIONS, noFilter), drawn(open.pick(RootView.AUTOMATIONS, assistantOpen = false)))
		assertEquals(Drawn.Root(RootView.BACKLOG, null), drawn(open.pick(RootView.VAULT, assistantOpen = false).leave()))
		assertEquals(Drawn.Root(RootView.VAULT, null), drawn(ShellNav().pick(RootView.VAULT, assistantOpen = false)))
	}

	@Test
	fun `the assistant's session filters nothing, and Assistant returns to its chat`() {
		val open = ShellNav().arriveAt(a, assistant = true, Arrival.OUTSIDE, facts)
		val picked = open.pick(RootView.BACKLOG, assistantOpen = true)
		val f = shellFacts(assistantOpen = true)

		assertEquals(RootView.ASSISTANT, menuShown(drawn(open, f)))
		assertEquals(Drawn.Root(RootView.BACKLOG, Over(a, filterable = false, ViewScope.Everything)), drawn(picked, f))
		assertFalse(showsAssistant(drawn(picked, f)))
		assertEquals(open, picked.pick(RootView.ASSISTANT, assistantOpen = true))
		assertEquals(Drawn.Root(RootView.SESSIONS, null), drawn(picked.pick(RootView.SESSIONS, assistantOpen = true), f))
	}

	@Test
	fun `an arrival, a leave and a view no longer offered each drop a pick, and a saved entry returns to the session`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts)
		val picked = open.pick(RootView.BACKLOG, assistantOpen = false)

		assertEquals(ShellScreen.CONVERSATION, drawn(picked.arrive(b, Arrival.TAB, facts)).kind)
		assertEquals(Drawn.Root(RootView.SESSIONS, null), drawn(picked.forgot(a)))
		assertEquals(open, picked.offering(rootViews(DrawerFeatures(board = false, vault = true))))
		assertEquals(picked, picked.offering(offered))
		assertEquals(open, picked.boardSaved())
		assertEquals(Drawn.Root(RootView.SESSIONS, null), drawn(ShellNav().showRoot(RootView.BACKLOG).boardSaved()))
	}

	@Test
	fun `a page's exit to a root view closes the stack, over a session or at the root`() {
		val source = ShellPage.Source("sakura", "github")
		val atRoot = ShellNav().showRoot(RootView.SOURCES).push(ShellPage.Add).push(source)
		val inSession = ShellNav().arrive(a, Arrival.OUTSIDE, facts).push(source)

		assertEquals(Drawn.Root(RootView.AUTOMATIONS, null), drawn(atRoot.toRoot(RootView.AUTOMATIONS, assistantOpen = false)))
		assertEquals(
			Drawn.Root(RootView.AUTOMATIONS, Over(a, filterable = false, ViewScope.Everything)),
			drawn(inSession.toRoot(RootView.AUTOMATIONS, assistantOpen = false)),
		)
	}

	@Test
	fun `only the assistant's own pages and a page over its chat count as the assistant shown, and every page reads the home`() {
		val device = ShellNav().showRoot(RootView.SOURCES).push(ShellPage.Device("sakura", "aa:bb:cc:dd:ee:01"))
		val safety = ShellNav().push(ShellPage.Safety)

		assertFalse(showsAssistant(drawn(device)))
		assertTrue(showsAssistant(drawn(device, shellFacts(assistantOpen = true))))
		assertTrue(showsAssistant(drawn(safety)))
		assertTrue(readsHome(drawn(device)))
	}

	@Test
	fun `Sources and Automations read the home as the assistant's own screens do`() {
		val sources = ShellNav().showRoot(RootView.SOURCES)
		val over = ShellNav().arrive(a, Arrival.OUTSIDE, facts).pick(RootView.AUTOMATIONS, assistantOpen = false)
		val vault = ShellNav().showRoot(RootView.VAULT)

		assertTrue(readsHome(drawn(sources)))
		assertFalse(showsAssistant(drawn(sources)))
		assertTrue(readsHome(drawn(over)))
		assertFalse(readsHome(drawn(vault)))
		assertTrue(readsHome(drawn(ShellNav().showRoot(RootView.ASSISTANT))))
		assertFalse(readsHome(drawn(sources.openSettings())))
		assertEquals(ShellScreen.ROOT to RootView.SOURCES, homeReadKey(drawn(sources)))
		assertNull(homeReadKey(drawn(vault)))
	}

	@Test
	fun `the root, settings and every page survive recreation, an unreadable page is dropped, and the conversation is not kept`() {
		val pages = listOf(
			ShellPage.Settings,
			ShellPage.Location,
			ShellPage.Features,
			ShellPage.Safety,
			ShellPage.Source("sakura", "github"),
			ShellPage.SourceAutomations("sakura", "github"),
			ShellPage.Add,
			ShellPage.Entry("sakura", "kasa"),
			ShellPage.Setup("sakura", "kasa"),
			ShellPage.Device("sakura", "aa:bb:cc:dd:ee:01"),
		)
		val scope = SaverScope { true }
		val roundTrip = { nav: ShellNav -> ShellNav.saver.restore(with(ShellNav.saver) { scope.save(nav) }!!)!! }
		val stacked = pages.fold(ShellNav().showRoot(RootView.ASSISTANT)) { nav, page -> nav.push(page) }

		assertEquals(stacked, roundTrip(stacked))
		assertEquals(Drawn.Settings(SettingsRoute.SECURITY), drawn(roundTrip(stacked.openSettings(SettingsRoute.SECURITY))))
		assertEquals(pages.size, pages.map(::pageKey).toSet().size)

		val saved = listOf(RootView.ASSISTANT.name, "", pageKey(ShellPage.Add), "nonsense", pageKey(ShellPage.Safety))
		assertEquals(ShellNav().showRoot(RootView.ASSISTANT).push(ShellPage.Add).push(ShellPage.Safety), ShellNav.saver.restore(saved))

		val inSession = ShellNav().arrive(a, Arrival.OUTSIDE, facts).push(ShellPage.Add)
		val restored = roundTrip(inSession)
		assertNull(restored.heldTeam)
		assertEquals(listOf(BackLayer.PAGE), backAll(restored))
	}

	@Test
	fun `a tab switch keeps the view and re-snaps, a closed tab keeps it quietly, and a fresh open starts on chat`() {
		val opened = ShellNav().arrive(a, Arrival.OUTSIDE, facts)
		val switched = opened.showView(ConversationView.FILES).arrive(b, Arrival.TAB, facts)
		val closed = switched.arrive(a, Arrival.CLOSED_TAB, facts)
		val reopened = closed.leave().arrive(b, Arrival.OUTSIDE, facts)

		assertEquals(ConversationView.FILES, conversation(switched).view)
		assertEquals(ConversationView.FILES, conversation(closed).view)
		assertEquals(ConversationView.CHAT, conversation(reopened).view)
		assertEquals(listOf(1, 2, 2, 3), listOf(opened, switched, closed, reopened).map { conversation(it).openNonce })
	}

	@Test
	fun `a ref's exit lands on its place, and Back walks Files, then the view, then leaves`() {
		val browsing = ShellNav().arrive(a, Arrival.OUTSIDE, facts).showView(ConversationView.FILES)
			.pushFiles(WorkspacePlace.Tree("src"))
		val asked = browsing.arrive(a, Arrival.FILES_ASKED, facts, WorkspacePlace.Windows)

		assertEquals(listOf(WORKSPACE_ROOT, WorkspacePlace.Windows), conversation(asked).files)
		assertEquals(conversation(browsing).openNonce, conversation(asked).openNonce)
		assertEquals(
			listOf(BackLayer.FILES, BackLayer.VIEW, BackLayer.CONVERSATION),
			backAll(asked),
		)
	}

	// Back unwinds drill-ins first.
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

		assertEquals(listOf(WORKSPACE_ROOT), conversation(deep.arrive(b, Arrival.TAB, facts)).files)
		assertEquals(listOf(WORKSPACE_ROOT, WorkspacePlace.Tree("src")), conversation(deep.arrive(a, Arrival.TAB, facts)).files)
	}

	@Test
	fun `an editor, an overlay, settings and an open drawer each outrank the Files stack`() {
		val deep = ShellNav().arrive(a, Arrival.OUTSIDE, facts).showView(ConversationView.FILES)
			.pushFiles(WorkspacePlace.Tree("src"))

		assertEquals(BackLayer.EDITOR, backLayer(deep, shellFacts(editorOpen = true, drawerOpen = true)))
		assertEquals(BackLayer.OVERLAY, backLayer(deep, shellFacts(overlayOpen = true, drawerOpen = true)))
		assertEquals(BackLayer.SETTINGS, backLayer(deep.openSettings(), shellFacts(drawerOpen = true)))
		assertEquals(BackLayer.DRAWER, backLayer(deep, shellFacts(drawerOpen = true)))
		assertEquals(BackLayer.FILES, backLayer(deep, shellFacts()))
	}

	@Test
	fun `nothing navigates behind the lock or before boot, and a root view steps back to sessions`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts)

		assertNull(backLayer(open, shellFacts(locked = true)))
		assertNull(backLayer(open, shellFacts(locked = true, editorOpen = true)))
		assertNull(backLayer(open, shellFacts(booted = false)))
		assertEquals(BackLayer.SETTINGS, backLayer(open.openSettings(), shellFacts(booted = false)))
		assertEquals(listOf(BackLayer.ROOT_VIEW), backAll(ShellNav().showRoot(RootView.VAULT)))
	}

	@Test
	fun `settings Back returns through Domain and Trust once provisioned, and closes from the hub`() {
		assertEquals(SettingsRoute.NETWORKS, settingsBack(SettingsRoute.FEDERATION, provisioned = true))
		assertEquals(SettingsRoute.HUB, settingsBack(SettingsRoute.FEDERATION, provisioned = false))
		assertEquals(SettingsRoute.HUB, settingsBack(SettingsRoute.SECURITY, provisioned = true))
		// Hub before provisioning.
		assertNull(settingsBack(SettingsRoute.SECURITY, provisioned = false))
		assertEquals(
			listOf(BackLayer.SETTINGS, BackLayer.SETTINGS, BackLayer.SETTINGS),
			backAll(ShellNav().openSettings(SettingsRoute.FEDERATION)),
		)
	}

	// Render and Back share one value.
	@Test
	fun `the lock hides everything, an overlay hides settings, and settings open before boot`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts).openSettings()

		assertEquals(Drawn.Lock, drawn(open, shellFacts(locked = true, overlayOpen = true)))
		assertEquals(Drawn.Overlay, drawn(open, shellFacts(overlayOpen = true)))
		assertEquals(Drawn.Settings(SettingsRoute.HUB), drawn(open, shellFacts(booted = false)))
		assertEquals(Drawn.Boot, drawn(open.closeSettings(), shellFacts(booted = false)))
		assertEquals(ShellScreen.CONVERSATION, drawn(open.closeSettings()).kind)
		assertEquals(ShellScreen.ROOT, drawn(open.closeSettings().leave()).kind)
	}

	@Test
	fun `forgetting another session leaves the open one alone`() {
		val open = ShellNav().arrive(a, Arrival.OUTSIDE, facts)

		assertEquals(open, open.forgot(b))
		assertNull(open.forgot(a).heldTeam)
	}
}
