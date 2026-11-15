package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class ShellOverlaysTest {
	@Test
	fun aLateCloseLeavesTheModalThatReplacedIt() {
		val first = VaultModal.Request("first")
		val second = VaultModal.Request("second")
		val fire = RunbookFire("sakura", "release", null)
		val open = Modals(vault = second, fire = fire, board = "entry")

		assertEquals(open, open.without(vault = first))
		assertEquals(open.copy(vault = null), open.without(vault = second))
		assertEquals(open.copy(fire = null), open.without(fire = fire))
		assertEquals(open, open.without(board = "another", send = "sakura" to "request"))
		assertEquals(Modals(), open.without(vault = second, fire = fire, board = "entry"))
	}
}
