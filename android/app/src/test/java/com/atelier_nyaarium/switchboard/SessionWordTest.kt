package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionWordTest {
	private val now = 1_000_000L

	private fun row(status: String, limitBlocked: Boolean? = null) =
		Presence.reported(status = status, authority = Authority.LIVE, limitBlocked = limitBlocked)

	private fun word(presence: Presence, working: Boolean = false, needsLogin: Boolean = false) =
		sessionWord(presence, working = working, needsLogin = needsLogin, now = now)

	@Test
	fun `an online session reads limit, then login, then working, then live`() {
		assertEquals(SessionWord.LIMIT_HIT, word(row(Presence.ONLINE, limitBlocked = true), working = true, needsLogin = true))
		assertEquals(SessionWord.CHECK_TERMINAL, word(row(Presence.ONLINE), working = true, needsLogin = true))
		assertEquals(SessionWord.WORKING, word(row(Presence.ONLINE), working = true))
		assertEquals(SessionWord.LIVE, word(row(Presence.ONLINE)))
	}

	@Test
	fun `a verifying session reads verifying and pulses, whatever else is folded in`() {
		val verifying = word(row(Presence.VERIFYING), working = true, needsLogin = true)

		assertEquals(SessionWord.VERIFYING, verifying)
		assertTrue(verifying.busy)
	}

	@Test
	fun `an asleep session reads waking for this device's wake or a send waiting on one`() {
		val asked = row(Presence.AVAILABLE).withReceipt(ActionReceipt(opId = "op", at = now - 1_000))

		assertEquals(SessionWord.WAKING, word(asked))
		assertEquals(SessionWord.WAKING, word(row(Presence.AVAILABLE), working = true))
		assertEquals(SessionWord.AVAILABLE, word(row(Presence.AVAILABLE)))
	}

	@Test
	fun `a failed wake does not read as waking`() {
		val failed = row(Presence.AVAILABLE).withReceipt(ActionReceipt("op", now - 1_000, ActionReceipt.Outcome.FAILED))

		assertEquals(SessionWord.AVAILABLE, word(failed))
	}

	@Test
	fun `an ended session stays ended while working, and a limit only counts online`() {
		assertEquals(SessionWord.ENDED, word(Presence.ended(), working = true))
		assertEquals(SessionWord.ENDED, word(row("something-new")))
		assertEquals(SessionWord.AVAILABLE, word(row(Presence.AVAILABLE, limitBlocked = true)))
	}
}
