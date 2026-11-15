package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DrawerNavTest {
	private val everything = DrawerFeatures(board = true, vault = true)

	@Test
	fun `the menu lists every view in three groups`() {
		val groups = rootViews(everything).groupBy { it.group }.values.toList()

		assertEquals(
			listOf(
				listOf(RootView.SESSIONS, RootView.ASSISTANT, RootView.BACKLOG),
				listOf(RootView.SOURCES, RootView.AUTOMATIONS, RootView.ROUTINES, RootView.RUNBOOKS),
				listOf(RootView.VAULT, RootView.POLICIES, RootView.CONSOLE),
			),
			groups,
		)
	}

	@Test
	fun `a view whose plugin is off is not offered, and a held one falls back to the first`() {
		val offered = rootViews(DrawerFeatures(board = false, vault = false))

		assertEquals(
			listOf(
				RootView.SESSIONS,
				RootView.ASSISTANT,
				RootView.SOURCES,
				RootView.AUTOMATIONS,
				RootView.ROUTINES,
				RootView.RUNBOOKS,
				RootView.CONSOLE,
			),
			offered,
		)
		assertEquals(RootView.SESSIONS, shownView(offered, RootView.VAULT))
		assertEquals(RootView.ROUTINES, shownView(offered, RootView.ROUTINES))
	}

	@Test
	fun `a session offers its terminal only when the pane can be driven, and the assistant has no Files`() {
		assertEquals(listOf(ConversationView.CHAT, ConversationView.FILES), conversationViews(terminal = false, assistant = false))
		assertEquals(ConversationView.entries, conversationViews(terminal = true, assistant = false))
		assertEquals(listOf(ConversationView.CHAT, ConversationView.TERMINAL), conversationViews(terminal = true, assistant = true))
		assertEquals(
			ConversationView.CHAT,
			shownView(conversationViews(terminal = false, assistant = false), ConversationView.TERMINAL),
		)
	}

	@Test
	fun `Back walks to the first view, then leaves`() {
		val offered = conversationViews(terminal = true, assistant = false)

		assertEquals(ConversationView.CHAT, backFrom(offered, ConversationView.FILES))
		assertNull(backFrom(offered, ConversationView.CHAT))
	}

	@Test
	fun `a tab switch keeps the view, and arriving from outside starts on chat`() {
		val offered = conversationViews(terminal = true, assistant = false)

		assertEquals(ConversationView.FILES, arrivedView(ConversationView.FILES, offered, Arrival.TAB, stuckAtLogin = false))
		assertEquals(ConversationView.CHAT, arrivedView(ConversationView.FILES, offered, Arrival.OUTSIDE, stuckAtLogin = false))
	}

	@Test
	fun `a login prompt outranks the held view, and a ref's exit outranks both`() {
		val withTerminal = conversationViews(terminal = true, assistant = false)
		val without = conversationViews(terminal = false, assistant = false)

		assertEquals(ConversationView.TERMINAL, arrivedView(ConversationView.FILES, withTerminal, Arrival.TAB, stuckAtLogin = true))
		assertEquals(ConversationView.TERMINAL, arrivedView(ConversationView.CHAT, withTerminal, Arrival.OUTSIDE, stuckAtLogin = true))
		assertEquals(ConversationView.CHAT, arrivedView(ConversationView.CHAT, without, Arrival.OUTSIDE, stuckAtLogin = true))
		assertEquals(ConversationView.FILES, arrivedView(ConversationView.CHAT, withTerminal, Arrival.FILES_ASKED, stuckAtLogin = true))
	}

	@Test
	fun `pending requests badge the vault alone, and a badge dots the button`() {
		val views = rootViews(everything)

		assertEquals(2, rootBadge(RootView.VAULT, 2))
		assertNull(rootBadge(RootView.VAULT, 0))
		assertNull(rootBadge(RootView.BACKLOG, 2))
		assertTrue(anyBadge(views.map { rootBadge(it, 2) }))
		assertFalse(anyBadge(views.map { rootBadge(it, 0) }))
	}

	@Test
	fun `the menu button sits left unless right was stored`() {
		assertEquals(DrawerSide.LEFT, DrawerSide.of(null))
		assertEquals(DrawerSide.LEFT, DrawerSide.of("sideways"))
		assertEquals(DrawerSide.RIGHT, DrawerSide.of(DrawerSide.RIGHT.name))
	}

	@Test
	fun `a closed drawer opens from the edge a drag leaves, and a shown one only closes`() {
		val width = 300f
		val closed = drawerAnchors(DrawerSlot.CLOSED, width)
		assertEquals(width, closed[DrawerSlot.LEFT])
		assertEquals(-width, closed[DrawerSlot.RIGHT])
		assertEquals(setOf(DrawerSlot.CLOSED, DrawerSlot.LEFT), drawerAnchors(DrawerSlot.LEFT, width).keys)
		assertEquals(setOf(DrawerSlot.CLOSED, DrawerSlot.RIGHT), drawerAnchors(DrawerSlot.RIGHT, width).keys)

		assertEquals(DrawerSlot.LEFT, slotShown(40f))
		assertEquals(DrawerSlot.RIGHT, slotShown(-40f))
		assertEquals(DrawerSlot.CLOSED, slotShown(0f))
		assertEquals(-260f, sheetX(DrawerSlot.LEFT, 40f, width, screen = 1080))
		assertEquals(1040f, sheetX(DrawerSlot.RIGHT, -40f, width, screen = 1080))
		assertEquals(780f, sheetX(DrawerSlot.RIGHT, -width, width, screen = 1080))
	}

	@Test
	fun `only a near-horizontal swipe past slop claims the drawer`() {
		assertNull(swipeClaim(10f, 2f, slop = 20f))
		assertEquals(true, swipeClaim(-40f, 10f, slop = 20f))
		assertEquals(false, swipeClaim(25f, 60f, slop = 20f))
		assertEquals(false, swipeClaim(30f, 15f, slop = 20f))
	}

	@Test
	fun `a released drawer follows a fling, and otherwise the nearer half`() {
		val width = 300f
		val fling = 1000f
		assertEquals(DrawerSlot.LEFT, releasedSlot(60f, 1500f, width, fling))
		assertEquals(DrawerSlot.CLOSED, releasedSlot(250f, -1500f, width, fling))
		assertEquals(DrawerSlot.RIGHT, releasedSlot(-200f, 0f, width, fling))
		assertEquals(DrawerSlot.CLOSED, releasedSlot(-100f, 0f, width, fling))
		assertEquals(DrawerSlot.CLOSED, releasedSlot(0f, 5000f, width, fling))
	}
}
