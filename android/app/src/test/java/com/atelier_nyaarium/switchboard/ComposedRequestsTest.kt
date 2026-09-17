package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposedRequestsTest {
	private class HeldHost : WorkspaceHost {
		override val workspace: WorkspaceGateway? = null
		override val generation = WorkspaceGeneration()
		val sent = mutableListOf<String>()
		val holds = mutableListOf<TestHold>()
		var sends = true
		var throws = false

		override suspend fun send(address: String, text: String): Boolean {
			holds.removeFirstOrNull()?.pass()
			if (throws) throw IllegalStateException("socket gone")
			sent += text
			return sends
		}
	}

	private val host = HeldHost()
	private val requests = ComposedRequests(host)
	private val key = RequestKey("home.sakura.host.aaa", RequestKind.KNOWLEDGE, "why")

	/** One write per key, as a site's own map holds it. */
	private val written = mutableMapOf<String, String>()

	/** A site writing before its send, keyed as the sites key theirs. */
	private suspend fun submitWriting(
		key: RequestKey,
		name: String,
		admission: RequestAdmission = requests.admit(),
	): Submitted {
		val previous = written.put(key.subject, name)
		return requests.submit(key, "record why", admission, RequestHold {
			if (written[key.subject] == name) {
				if (previous == null) written -= key.subject else written[key.subject] = previous
			}
		})
	}

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
	fun `a send that throws is unknown rather than failed, and can be sent again`() = runBlocking {
		host.throws = true
		assertEquals(Submitted.Unknown, requests.submit(key, "record why"))
		assertEquals(RequestState.FAILED, requests.states.value[key])
		assertTrue(host.sent.isEmpty())

		host.throws = false
		assertEquals(Submitted.Sent, requests.submit(key, "record why"))
		assertEquals(listOf("record why"), host.sent.toList())
		assertEquals(RequestState.SENT, requests.states.value[key])
	}

	@Test
	fun `each file sent to the agent is its own request, naming that file`() = runBlocking {
		val target = WorkspaceTarget(gatewayId = "sakura", address = key.address)

		assertEquals(Submitted.Sent, requests.sendFile(target, "src/a.ts"))
		assertEquals(Submitted.Sent, requests.sendFile(target, "src/b.ts"))

		assertEquals(2, host.sent.size)
		assertTrue(host.sent[1].contains("src/b.ts"))
		assertEquals(RequestState.SENT, requests.states.value[fileRequest(target, "src/a.ts")])
	}

	@Test
	fun `a request admitted before a re-provision still leaves, and its landing draws nothing, not even over a newer claim`() =
		runBlocking {
			val other = key.copy(subject = "usage")
			val holds = listOf(TestHold(), TestHold()).also { host.holds += it }
			val pending = async { requests.submit(key, "record why") }
			val pendingOther = async { requests.submit(other, "record usage") }
			holds.forEach { it.entered.await() }
			host.generation.advance()
			requests.clearInMemory()
			val newer = TestHold().also { host.holds += it }
			val current = async { requests.submit(key, "record why again") }
			newer.entered.await()

			holds.forEach { it.release() }
			assertEquals(Submitted.Sent, pending.await())
			assertEquals(Submitted.Sent, pendingOther.await())
			assertEquals(RequestState.SENDING, requests.states.value[key])
			assertNull(requests.states.value[other])

			newer.release()
			assertEquals(Submitted.Sent, current.await())
			assertEquals(listOf("record why", "record usage", "record why again"), host.sent.toList())
			assertEquals(RequestState.SENT, requests.states.value[key])
		}

	@Test
	fun `a caller that began before a re-provision sends nothing and draws nothing`() = runBlocking {
		val admission = requests.admit()
		host.generation.advance()
		requests.clearInMemory()

		assertEquals(Submitted.Failed, submitWriting(key, "stale", admission))

		assertTrue(host.sent.isEmpty())
		assertTrue(written.isEmpty())
		assertNull(requests.states.value[key])
	}

	// Released before asserting, or a broken rule hangs.
	@Test
	fun `a caller that began before a re-provision is refused, never told a newer send of its key is out`() = runBlocking {
		val stale = requests.admit()
		host.generation.advance()
		requests.clearInMemory()
		val hold = TestHold().also { host.holds += it }
		val current = async { submitWriting(key, "current") }
		hold.entered.await()
		val refused = submitWriting(key, "stale", stale)
		val whileSending = written.toMap()

		hold.release()
		assertEquals(Submitted.Sent, current.await())
		assertEquals(Submitted.Failed, refused)
		assertEquals(mapOf("why" to "current"), whileSending)
		assertEquals(mapOf("why" to "current"), written.toMap())
	}

	@Test
	fun `a write stays when the send lands and when its outcome is unknown, and comes back out when it failed`() =
		runBlocking {
			assertEquals(Submitted.Sent, submitWriting(key, "sent"))

			host.throws = true
			assertEquals(Submitted.Unknown, submitWriting(key.copy(subject = "usage"), "unknown"))

			host.throws = false
			host.sends = false
			assertEquals(Submitted.Failed, submitWriting(key.copy(subject = "contract"), "failed"))

			assertEquals(mapOf("why" to "sent", "usage" to "unknown"), written.toMap())
		}

	// Released before asserting, or a broken rule hangs.
	@Test
	fun `a write that collided with a send already out puts back the one it replaced`() = runBlocking {
		assertEquals(Submitted.Sent, submitWriting(key, "first"))

		val hold = TestHold().also { host.holds += it }
		val sending = async { submitWriting(key, "second") }
		hold.entered.await()
		val collided = submitWriting(key, "third")
		val whileSending = written.toMap()

		hold.release()
		assertEquals(Submitted.Sent, sending.await())
		assertEquals(Submitted.AlreadySending, collided)
		assertEquals(mapOf("why" to "second"), whileSending)
		assertEquals(mapOf("why" to "second"), written.toMap())
	}

	@Test
	fun `each admission names its own write, a re-provision included`() = runBlocking {
		val before = listOf(requests.admit().incarnation, requests.admit().incarnation)
		host.generation.advance()
		requests.clearInMemory()
		val after = requests.admit().incarnation

		assertEquals(before.distinct(), before)
		assertFalse(after in before)
	}
}
