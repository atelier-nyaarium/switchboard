package com.atelier_nyaarium.switchboard.vault

import java.util.concurrent.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VaultBusyTest {
	@Test
	fun busyClearsWhenWorkIsCancelledAndCancellationEscapes() {
		val states = mutableListOf<Boolean>()
		var cancelled = false

		try {
			runBlocking {
				withBusyState({ states += it }) { throw CancellationException() }
			}
		} catch (_: CancellationException) {
			cancelled = true
		}

		assertTrue(cancelled)
		assertEquals(listOf(true, false), states)
	}
}
