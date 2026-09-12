package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleRunbookPreviewResult
import com.atelier_nyaarium.switchboard.runbooks.PreviewState
import com.atelier_nyaarium.switchboard.runbooks.previewOf
import com.atelier_nyaarium.switchboard.runbooks.stale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RunbookPreviewTest {
	@Test
	fun noAnswerIsBlockedAndOffersOverwriteOnlyBehindAStandingRefusal() {
		assertEquals(PreviewState.Blocked(null, canOverwrite = false), previewOf(null, null))
		assertEquals(PreviewState.Blocked("moved", canOverwrite = true), previewOf(null, SaveRefusal("moved", 3L)))
	}

	@Test
	fun textIsReadyAtTheGatewaysRevisionAndNoTextIsRefused() {
		assertEquals(PreviewState.Ready("hi", 7L), previewOf(ConsoleRunbookPreviewResult(text = "hi", revision = 7L), null))
		assertTrue(previewOf(ConsoleRunbookPreviewResult(revision = 7L, reason = "scope has no value"), null) is PreviewState.Refused)
	}

	@Test
	fun aReadyPreviewGoesStaleWithItsWordsAndAnythingElseGoesPending() {
		assertEquals(PreviewState.Stale("hi"), PreviewState.Ready("hi", 1L).stale())
		assertEquals(PreviewState.Pending, PreviewState.Refused("x").stale())
		assertEquals(PreviewState.Pending, PreviewState.Blocked(null).stale())
	}
}
