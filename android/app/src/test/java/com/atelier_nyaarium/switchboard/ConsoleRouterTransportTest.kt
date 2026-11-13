package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConsoleRouterTransportTest {
	private val events = mutableListOf<RouterEvent>()

	private fun transport(lan: List<String> = emptyList()): ConsoleRouterTransport {
		val store = testStore()
		store.saveRouterReach(RouterReach(lanAddresses = lan).encode())
		val blob = wireJson.encodeToString(
			com.atelier_nyaarium.switchboard.proto.Provisioning.serializer(),
			com.atelier_nyaarium.switchboard.proto.Provisioning(appToken = "token", device = "device", routerUrl = "https://router.example:20001"),
		)
		return ConsoleRouterTransport(ConsoleCredentials.parse(blob, store), store, {}) { events += it }
	}

	private fun response(code: Int, text: String) = ConsoleHttp.HttpTextResult(code, text)

	@Test
	fun aCallThatEveryAddressFailsTellsTheLinkOnce() = runBlocking {
		val door = transport(lan = listOf("192.168.1.5"))
		val tried = mutableListOf<String>()

		val thrown = runCatching {
			door.withReachFailover<Unit> { base ->
				tried += base
				throw java.net.ConnectException("refused")
			}
		}.exceptionOrNull()

		assertTrue(thrown is java.net.ConnectException)
		assertEquals(2, tried.size)
		assertEquals(listOf<RouterEvent>(RouterEvent.Missed(Miss.UNREACHABLE)), events)
	}

	@Test
	fun aCallThatLandsOnAnotherAddressSaysNothingOfTheFirst() = runBlocking {
		val door = transport(lan = listOf("192.168.1.5"))
		var tries = 0

		val answer = door.withReachFailover { if (tries++ == 0) throw java.net.ConnectException("refused") else "landed" }

		assertEquals("landed", answer)
		assertEquals(emptyList<RouterEvent>(), events)
	}

	@Test
	fun anOwnerOpResponseTellsTheLinkWhatItSaysOfThisDevice() {
		val door = transport()
		val refused = """{"outcome":"${Protocol.Wire.OP_OUTCOME_REFUSED}","reason":"${Protocol.Wire.OP_REASON_NOT_ADMITTED}"}"""

		door.ownerAnswer(response(200, "[]"))
		door.ownerAnswer(response(200, refused))
		val status = runCatching { door.ownerAnswer(response(401, "Unauthorized")) }.exceptionOrNull()
		runCatching { door.ownerAnswer(response(200, "not json")) }

		assertEquals(401, (status as RouterStatus).code)
		assertEquals(
			listOf(
				RouterEvent.Accepted,
				RouterEvent.Refused(Refusal.NOT_ADMITTED),
				RouterEvent.Refused(Refusal.TOKEN_REJECTED),
				RouterEvent.Reached,
			),
			events,
		)
	}
}
