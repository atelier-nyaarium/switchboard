package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleSessionCutPlanResult
import com.atelier_nyaarium.switchboard.proto.ConsoleSessionCutStartResult
import com.atelier_nyaarium.switchboard.proto.HarnessWord
import com.atelier_nyaarium.switchboard.proto.SessionHarness
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionCutTest {
	private fun row(name: String, harness: SessionHarness, role: String? = null) =
		Team(name = name, presence = Presence.ended(), role = role, harness = HarnessWord.Named(harness))

	@Test
	fun offeredOnlyForAHostClaudeSessionThatIsNotTheAssistant() {
		assertTrue(cutOffered(row("dom.sakura.host.work", SessionHarness.CLAUDE)))
		assertFalse(cutOffered(row("dom.sakura.host.work", SessionHarness.COPILOT)))
		assertFalse(cutOffered(row("dom.sakura.recipe-app.work", SessionHarness.CLAUDE)))
		assertFalse(cutOffered(row("dom.sakura.host.assistant", SessionHarness.CLAUDE, role = "assistant")))
		assertFalse(cutOffered(row("dom.sakura.host", SessionHarness.CLAUDE)))
		assertFalse(cutOffered(null))
	}

	@Test
	fun theOwnersWordsFindTheirTurnAndAnyOtherRowFindsItByTime() {
		val sent = Message(fromMe = true, text = "ship it", at = 500L)
		val reply = Message(fromMe = false, text = "shipped", at = 900L)
		val filesOnly = Message(fromMe = true, text = "", at = 700L)

		assertEquals(CutRow(500L, "ship it"), cutRowOf(sent))
		assertEquals(CutRow(900L, null), cutRowOf(reply))
		assertEquals(CutRow(700L, null), cutRowOf(filesOnly))
	}

	@Test
	fun aPlanReadsAsItsLinesAndARefusalAsItsReason() {
		val planned = cutPlanView(
			ConsoleSessionCutPlanResult(
				planned = true,
				keepText = "next task",
				snapped = true,
				keptRows = 40,
				foldedRows = 900,
				keptBytes = 3L shl 20,
				sourceBytes = 800L shl 20,
			),
		) as CutPlanView.Planned
		val refused = cutPlanView(ConsoleSessionCutPlanResult(planned = false, reason = "busy", detail = "This session is working."))

		val unsnapped = cutPlanView(ConsoleSessionCutPlanResult(planned = true, keepText = "next task", snapped = false)) as CutPlanView.Planned

		assertEquals(planned.lines.size, unsnapped.lines.size + 1)
		assertTrue(planned.lines.any { it.contains("800.0 MB") && it.contains("3.0 MB") })
		assertEquals(CutPlanView.Refused("This session is working."), refused)
		assertTrue(cutPlanView(null) is CutPlanView.Refused)
	}

	@Test
	fun aClearRunsThroughTheRowAboveThePressedOneAndKeepsIt() {
		val team = "dom.sakura.host.work"
		val thread = (0L..3L).map { Message(fromMe = false, text = "m$it", at = 100L + it, id = it) }
		val state = ChatState(threads = mapOf(team to thread))

		assertEquals(thread[1], rowAbove(state, team, 2L, 102L))
		assertNull(rowAbove(state, team, 0L, 100L))
		assertNull(rowAbove(state, team, 2L, 999L))
	}

	@Test
	fun aConfirmationNamesWhatThePhoneClearsOnlyWhenItClearsSomething() {
		val planned = CutPlanView.Planned(listOf("plan"))

		assertEquals("plan", cutConfirmBody(planned, emptyList()))
		assertTrue(cutConfirmBody(planned, listOf("- 3 messages")).endsWith("- 3 messages"))
		assertEquals("no", cutConfirmBody(CutPlanView.Refused("no"), listOf("- 3 messages")))
	}

	@Test
	fun sizesShowOneDecimalPastAMegabyte() {
		assertEquals("1.0 GB", sizeText((1L shl 30) + (1L shl 20)))
		assertEquals("158 KB", sizeText(158L * 1024))
		assertEquals("2.5 MB", sizeText(5L shl 19))
	}

	@Test
	fun aStartedCutSaysNothingAndARefusedOneSaysWhy() {
		assertNull(cutStartLine(ConsoleSessionCutStartResult(started = true)))
		assertTrue(cutStartLine(ConsoleSessionCutStartResult(started = false, detail = "busy"))!!.contains("busy"))
		assertTrue(cutStartLine(null)!!.isNotBlank())
	}
}
