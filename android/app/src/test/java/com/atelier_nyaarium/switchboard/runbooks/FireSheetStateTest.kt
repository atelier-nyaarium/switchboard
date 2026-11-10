package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.SpawnHarnesses
import com.atelier_nyaarium.switchboard.proto.CliPick
import com.atelier_nyaarium.switchboard.proto.Runbook
import com.atelier_nyaarium.switchboard.proto.SessionHarness
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
	fun `a default pick follows the spawn point and a tapped one stays`() {
		val sheet = FireSheetState(runbook)
		val everyCli = SpawnHarnesses.Known(SessionHarness.entries.toSet())
		val copilotOnly = SpawnHarnesses.Known(setOf(SessionHarness.COPILOT))

		sheet.pick("home.sakura.host", everyCli)
		assertEquals(CliPick.Picked(SessionHarness.CLAUDE), sheet.cli)
		sheet.pick("home.sakura.windows", copilotOnly)
		assertEquals(CliPick.Picked(SessionHarness.COPILOT), sheet.cli)

		sheet.pick("home.sakura.host", everyCli)
		sheet.tapCli(SessionHarness.OPENCODE.wire, everyCli)
		sheet.pick("home.sakura.windows", copilotOnly)
		assertEquals(CliPick.Picked(SessionHarness.OPENCODE), sheet.cli)
	}

	@Test
	fun `fires with no pick only where the CLIs are unknown`() {
		val sheet = FireSheetState(runbook)
		val unopened = SpawnHarnesses.UNOPENED_CONTAINER

		assertFalse(sheet.canFire(unopened))
		sheet.pick("home.sakura.app", unopened)
		sheet.tapCli(SessionHarness.CLAUDE.wire, unopened)
		assertEquals(CliPick.Unpicked, sheet.cli)
		assertTrue(sheet.canFire(unopened))
		assertFalse(sheet.canFire(SpawnHarnesses.Known(setOf(SessionHarness.CLAUDE, SessionHarness.COPILOT))))
	}

	@Test
	fun `starts a new session without a destination`() {
		val sheet = FireSheetState(runbook)

		assertTrue(sheet.freshSession)
		sheet.aimAt(false)
		assertEquals("", sheet.target)
	}
}
