package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantLockedFormTest {
	private val record = { count: Int ->
		ActionRecord(notify = true, threads = (1..count).map { RecordThread("t$it", "Private thread $it", null, "done") })
	}

	@Test
	fun aLockedLineIsTheTitleOrAFixedLineAndNeverTheSummaryOrBody() {
		val lines = listOf(
			Message(false, "secret body", 1L, title = "Build is green", summary = "secret summary"),
			Message(false, "secret body", 2L, summary = "secret summary"),
			Message(false, "secret body", 3L, title = "Line one\nline two"),
			Message(false, "summary of threads", 4L, title = "Cleared GitHub", record = record(3)),
			Message(false, "", 5L, record = record(1)),
			Message(false, "peer secret", 6L, title = "Peer title", isPeer = true),
			Message(true, "my own words", 7L, title = "Mine"),
		).map(::lockedLine)

		assertEquals(
			listOf(
				"Build is green",
				ASSISTANT_GENERIC_LINE,
				"Line one line two",
				"Assistant finished 3 items",
				"Assistant finished 1 item",
				ASSISTANT_GENERIC_LINE,
				ASSISTANT_GENERIC_LINE,
			),
			lines,
		)
	}

	@Test
	fun onlyALockedPhoneSpeaksAnAssistantRowInItsLockedTier() {
		val full = SttsPlayer.Tier.FULL

		assertEquals(
			listOf(SttsPlayer.Tier.LOCKED, full, full, full),
			listOf(
				spokenTier(assistant = true, locked = true, full),
				spokenTier(assistant = true, locked = false, full),
				spokenTier(assistant = false, locked = true, full),
				spokenTier(assistant = false, locked = false, full),
			),
		)
	}
}
