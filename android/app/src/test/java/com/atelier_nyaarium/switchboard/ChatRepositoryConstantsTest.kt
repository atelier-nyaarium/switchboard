package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Protocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Relations the compiler cannot check. */
class ChatRepositoryConstantsTest {

	@Test
	fun phoneLimitsReadTheGeneratedWireValues() {
		assertEquals(Protocol.MAX_BLOB_BYTES, ChatRepository.MAX_OUTGOING_BYTES)
		assertEquals(Protocol.CONSOLE_ANSWER_WAIT_MS, ConsoleHttp.PINNED_READ_TIMEOUT_MS)
	}

	@Test
	fun spawnRetryWindowStaysComfortablyPastGatewayCreateSessionBound() {
		assertTrue(
			"SPAWN_RETRY_WINDOW_MS must stay comfortably past the gateway's create_session bound",
			ChatRepository.SPAWN_RETRY_WINDOW_MS > Protocol.CREATE_SESSION_BOUND_MS + 10_000L,
		)
	}
}
