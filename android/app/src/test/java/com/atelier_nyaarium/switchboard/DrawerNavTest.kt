package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DrawerNavTest {
	private val everything = DrawerFeatures(board = true, vault = true)
	private val team = "home.sakura.host.aaa"

	@Test
	fun `a view whose plugin is off is not offered, and a held one falls back to the first`() {
		val offered = rootViews(DrawerFeatures(board = false, vault = false))

		assertEquals(listOf(RootView.SESSIONS, RootView.RUNBOOKS, RootView.ROUTINES), offered)
		assertEquals(RootView.SESSIONS, shownView(offered, RootView.VAULT))
		assertEquals(RootView.ROUTINES, shownView(offered, RootView.ROUTINES))
	}

	@Test
	fun `a conversation offers its terminal only when the pane can be driven`() {
		assertFalse(ConversationView.TERMINAL in conversationViews(everything, terminal = false))
		assertEquals(ConversationView.entries, conversationViews(everything, terminal = true))
		assertEquals(ConversationView.CHAT, shownView(conversationViews(everything, terminal = false), ConversationView.TERMINAL))
	}

	@Test
	fun `Back walks to the first view, then leaves`() {
		val offered = conversationViews(everything, terminal = true)

		assertEquals(ConversationView.CHAT, backFrom(offered, ConversationView.FILES))
		assertNull(backFrom(offered, ConversationView.CHAT))
	}

	@Test
	fun `a tab switch keeps the view, and arriving from outside starts on chat`() {
		val offered = conversationViews(everything, terminal = true)

		assertEquals(ConversationView.VAULT, arrivedView(ConversationView.VAULT, offered, Arrival.TAB, stuckAtLogin = false))
		assertEquals(ConversationView.CHAT, arrivedView(ConversationView.VAULT, offered, Arrival.OUTSIDE, stuckAtLogin = false))
	}

	@Test
	fun `a login prompt outranks the held view, and a ref's exit outranks both`() {
		val withTerminal = conversationViews(everything, terminal = true)
		val without = conversationViews(everything, terminal = false)

		assertEquals(ConversationView.TERMINAL, arrivedView(ConversationView.VAULT, withTerminal, Arrival.TAB, stuckAtLogin = true))
		assertEquals(ConversationView.TERMINAL, arrivedView(ConversationView.CHAT, withTerminal, Arrival.OUTSIDE, stuckAtLogin = true))
		assertEquals(ConversationView.CHAT, arrivedView(ConversationView.CHAT, without, Arrival.OUTSIDE, stuckAtLogin = true))
		assertEquals(ConversationView.FILES, arrivedView(ConversationView.CHAT, withTerminal, Arrival.FILES_ASKED, stuckAtLogin = true))
	}

	@Test
	fun `a conversation's rows name their scope and counts, and only a badge dots the button`() {
		val quiet = ConversationFacts(team, openWindows = 0, undoneTasks = 0, pendingRequests = 0)
		val busy = quiet.copy(openWindows = 2, undoneTasks = 4, pendingRequests = 3)
		val quietMarks = ConversationView.entries.map { conversationMark(it, quiet) }

		assertEquals(DrawerMark.Detail("sakura"), conversationMark(ConversationView.RUNBOOKS, quiet))
		assertEquals(DrawerMark.Detail("sakura"), conversationMark(ConversationView.POLICIES, quiet))
		assertEquals(DrawerMark.Detail("host"), conversationMark(ConversationView.ROUTINES, quiet))
		assertNull(conversationMark(ConversationView.FILES, quiet))
		assertEquals(DrawerMark.Detail("2 windows"), conversationMark(ConversationView.FILES, busy))
		assertEquals(DrawerMark.Detail("4 open"), conversationMark(ConversationView.BACKLOG, busy))
		assertEquals(DrawerMark.Badge(3), conversationMark(ConversationView.VAULT, busy))
		assertFalse(anyBadge(quietMarks))
		assertTrue(anyBadge(ConversationView.entries.map { conversationMark(it, busy) }))
	}

	@Test
	fun `the root badges its vault alone`() {
		assertEquals(DrawerMark.Badge(2), rootMark(RootView.VAULT, 2))
		assertNull(rootMark(RootView.VAULT, 0))
		assertNull(rootMark(RootView.BACKLOG, 2))
	}

	// A stored value from another build must not strand the drawer on no side.
	@Test
	fun `the drawer opens on the right unless left was stored`() {
		assertEquals(DrawerSide.RIGHT, DrawerSide.of(null))
		assertEquals(DrawerSide.RIGHT, DrawerSide.of("sideways"))
		assertEquals(DrawerSide.LEFT, DrawerSide.of(DrawerSide.LEFT.name))
	}
}
