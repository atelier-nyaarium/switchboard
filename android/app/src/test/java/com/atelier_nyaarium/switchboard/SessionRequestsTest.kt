package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionRequestsTest {
	private class HeldHost : WorkspaceHost {
		override val workspace: WorkspaceGateway? = null
		override val generation = WorkspaceGeneration()
		val sent = mutableListOf<String>()
		val holds = mutableListOf<TestHold>()
		var sends = true

		override suspend fun send(address: String, text: String): Boolean {
			holds.removeFirstOrNull()?.pass()
			sent += text
			return sends
		}
	}

	private val host = HeldHost()
	private val requests = SessionRequests(host)
	private val key = RequestKey("home.sakura.host.aaa", RequestKind.KNOWLEDGE, "why")

	@Test
	fun `a request in flight is sent once however often it is submitted, and draws as sent after`() = runBlocking {
		val hold = TestHold().also { host.holds += it }
		val first = async { requests.submit(key, "record why") }
		hold.entered.await()

		assertEquals(Submitted.AlreadySending, requests.submit(key, "record why"))
		assertEquals(RequestState.SENDING, requests.states.value[key])

		hold.release()
		assertEquals(Submitted.Sent, first.await())
		assertEquals(listOf("record why"), host.sent.toList())
		assertEquals(RequestState.SENT, requests.states.value[key])
	}

	@Test
	fun `a failed request can be sent again, and one whose caller left still lands what happened`() = runBlocking {
		host.sends = false
		assertEquals(Submitted.Failed, requests.submit(key, "record why"))
		assertEquals(RequestState.FAILED, requests.states.value[key])

		host.sends = true
		assertEquals(Submitted.Sent, requests.submit(key, "record why"))

		val other = key.copy(subject = "usage")
		val hold = TestHold().also { host.holds += it }
		val cancelled = async { requests.submit(other, "record usage") }
		hold.entered.await()
		cancelled.cancel()
		hold.release()
		cancelled.join()
		assertEquals(RequestState.SENT, requests.states.value[other])
		assertEquals(listOf("record why", "record why", "record usage"), host.sent.toList())
	}

	@Test
	fun `a request answered after a re-provision draws nothing`() = runBlocking {
		val hold = TestHold().also { host.holds += it }
		val pending = async { requests.submit(key, "record why") }
		hold.entered.await()
		host.generation.advance()
		requests.clearInMemory()
		hold.release()
		pending.await()

		assertNull(requests.states.value[key])
	}
}
