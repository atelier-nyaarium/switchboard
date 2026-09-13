package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShellNavTest {
	private val features = DrawerFeatures(board = true, vault = true)
	private val views = conversationViews(features, terminal = true)
	private val facts = ArrivalFacts(views, stuckAtLogin = false)
	private val a = "home.sakura.host.aaa"
	private val b = "home.sakura.host.bbb"

	private fun backFacts(
		drawerOpen: Boolean = false,
		editorOpen: Boolean = false,
		overlayOpen: Boolean = false,
		locked: Boolean = false,
		booted: Boolean = true,
	) = BackFacts(editorOpen, locked, overlayOpen, booted, drawerOpen, rootViews(features), views)

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

	@Test
	fun `a tab switch keeps the view and re-snaps, a closed tab keeps it quietly, and a fresh open starts on chat`() {
		val opened = ShellNav().arrive(a, Arrival.OUTSIDE, facts)
		val switched = opened.showView(ConversationView.VAULT).arrive(b, Arrival.TAB, facts)
		val closed = switched.arrive(a, Arrival.CLOSED_TAB, facts)
		val reopened = closed.leave().arrive(b, Arrival.OUTSIDE, facts)

		assertEquals(ConversationView.VAULT, switched.conversation?.view)
		assertEquals(ConversationView.VAULT, closed.conversation?.view)
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
