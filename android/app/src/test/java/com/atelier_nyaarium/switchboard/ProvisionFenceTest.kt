package com.atelier_nyaarium.switchboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProvisionFenceTest {
	@Test
	fun workBegunBeforeAReprovisionNeverLandsAndNothingLandsWhileItWipes() {
		val fence = ProvisionFence()
		val before = fence.capture()
		assertEquals("landed", fence.land(before) { "landed" })

		fence.advance()
		val during = fence.capture()
		val rebased = fence.upcoming()
		assertTrue(fence.clearing)
		assertNull(fence.land(before) { "previous owner" })
		assertNull(fence.land(during) { "mid wipe" })
		assertNull(fence.land(rebased) { "mid wipe" })

		fence.settle()
		assertFalse(fence.clearing)
		assertNull(fence.land(before) { "previous owner" })
		// Begun mid wipe.
		assertNull(fence.land(during) { "previous owner" })
		assertEquals(rebased, fence.capture())
		assertEquals("next owner", fence.land(fence.capture()) { "next owner" })
	}
}
