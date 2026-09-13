package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.proto.Runbook
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FireSheetStateTest {
	private val runbook = Runbook(id = "tag", name = "Tag", body = "tag it", parameters = emptyList(), revision = 1L)

	@Test
	fun `restores the destination after switching modes`() {
		val sheet = FireSheetState(runbook, into = "home.sakura.host.aaa")

		assertFalse(sheet.freshSession)
		assertEquals("home.sakura.host.aaa", sheet.target)

		sheet.aimAt(true)
		assertEquals("", sheet.target)

		sheet.aimAt(false)
		assertEquals("home.sakura.host.aaa", sheet.target)
	}

	@Test
	fun `starts a new session without a destination`() {
		val sheet = FireSheetState(runbook)

		assertTrue(sheet.freshSession)
		sheet.aimAt(false)
		assertEquals("", sheet.target)
	}
}
