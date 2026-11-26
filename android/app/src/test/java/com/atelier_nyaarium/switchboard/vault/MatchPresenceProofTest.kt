package com.atelier_nyaarium.switchboard.vault

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MatchPresenceProofTest {
	private val proof = MatchPresenceProof("request-1", "entry-1", revision = 3L, lockEpoch = 7, givenAt = 10_000L)

	private fun reuse(
		held: MatchPresenceProof? = proof,
		requestId: String = "request-1",
		entryId: String = "entry-1",
		revision: Long? = 3L,
		lockEpoch: Int = 7,
		now: Long = 10_001L,
		appLockEngaged: Boolean = false,
	) = consumeMatchPresenceProof(held, requestId, entryId, revision, lockEpoch, now, appLockEngaged)

	@Test
	fun onlyTheSameRequestAndSecretWithinAMinuteCanReusePresenceOnce() {
		val used = reuse(now = 70_000L)
		assertTrue(used.reuse)
		assertNull(used.remaining)
		assertFalse(reuse(held = used.remaining).reuse)
		assertFalse(reuse(requestId = "request-2").reuse)
		assertFalse(reuse(entryId = "entry-2").reuse)
		assertFalse(reuse(now = 70_001L).reuse)
		assertFalse(reuse(now = 9_999L).reuse)
		assertFalse(reuse(appLockEngaged = true).reuse)
	}

	@Test
	fun aChangedSecretAGoneSecretOrARelockSpendsItUnused() {
		assertFalse(reuse(revision = 4L).reuse)
		assertFalse(reuse(revision = null).reuse)
		assertFalse(reuse(lockEpoch = 8).reuse)
		assertNull(reuse(lockEpoch = 8).remaining)
	}
}
