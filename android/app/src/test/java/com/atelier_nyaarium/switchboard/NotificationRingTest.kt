package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationRingTest {
	@Test
	fun replacesByKeyAndKeepsADismissedRowWithoutItsReply() {
		val ring = NotificationRing()
		ring.update("a", entry("a", postedAt = 1L))
		ring.update("a", entry("a", postedAt = 2L))
		ring.remove("a")

		val row = ring.all().single()
		assertEquals(2L, row.postedAt)
		assertFalse(row.showing)
		assertNull(row.replyAction)
	}

	@Test
	fun evictsDismissedRowsBeforeShowingOnes() {
		val ring = NotificationRing(capacity = 3)
		ring.update("old", entry("old", postedAt = 1L))
		ring.update("gone", entry("gone", postedAt = 2L))
		ring.remove("gone")
		ring.update("mid", entry("mid", postedAt = 3L))
		ring.update("new", entry("new", postedAt = 4L))

		assertEquals(listOf("old", "mid", "new"), ring.all().map { it.key })

		ring.update("newer", entry("newer", postedAt = 5L))

		assertEquals(listOf("mid", "new", "newer"), ring.all().map { it.key })
	}

	@Test
	fun reconcileDismissesWhatNoLongerShowsAndANullUpdateDrops() {
		val ring = NotificationRing()
		ring.update("kept", entry("kept", postedAt = 1L))
		ring.update("stale", entry("stale", postedAt = 2L))
		ring.update("dropped", entry("dropped", postedAt = 3L))
		ring.update("dropped", null)
		ring.reconcile(setOf("kept"))

		assertEquals(listOf("kept", "stale"), ring.all().map { it.key })
		assertTrue(ring.all().single { it.key == "kept" }.showing)
		assertFalse(ring.all().single { it.key == "stale" }.showing)
	}

	private fun entry(key: String, postedAt: Long) =
		NotificationEntry(key, "com.example.app", "App", null, null, postedAt, true, null)
}
