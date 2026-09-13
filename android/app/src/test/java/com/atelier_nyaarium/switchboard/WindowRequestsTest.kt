package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.RefFileMeta
import com.atelier_nyaarium.switchboard.proto.RefKeyMeta
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val MODULE = "src/shared/schemasRoutine.ts"

class WindowRequestsTest {
	private class Host : WorkspaceHost {
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

	private val host = Host()
	private val opened = mutableListOf<Pair<String, String>>()
	private val refused = mutableSetOf<String>()
	private var clock = 1_000_000L
	private val asks = WindowRequests(
		generation = host.generation,
		outbox = SessionRequests(host),
		open = { target, symbolId ->
			if (symbolId !in refused) opened += target.address to symbolId
			symbolId !in refused
		},
		scope = CoroutineScope(Dispatchers.Unconfined),
		now = { clock },
	)
	private val one = WorkspaceTarget(gatewayId = "sakura", address = "home.sakura.host.aaa")

	private fun reply(vararg symbolIds: String?, at: Long = clock + 1, fromMe: Boolean = false) =
		Message(
			fromMe = fromMe,
			text = "here",
			at = at,
			files = listOf(
				MessageFile(
					name = "refs",
					mime = "text/plain",
					role = "ref-snapshot",
					ref = RefFileMeta(
						refPath = MODULE,
						keys = symbolIds.map { RefKeyMeta(key = "k", startLine = 1, endLine = 2, quality = "exact", symbolId = it) },
					),
				),
			),
		)

	@Test
	fun `a reply naming symbols opens each once and lands once, and one naming none leaves the ask waiting`() = runBlocking {
		assertEquals(Submitted.Sent, asks.ask(one, MODULE, " the prose lines "))
		assertTrue(host.sent.single().contains(MODULE))

		asks.onMessage(one.address, reply(null))
		asks.onMessage(one.address, Message(fromMe = false, text = "thinking", at = clock + 1))
		assertNull(asks.requests.value.getValue(one.address).opened)

		asks.onMessage(one.address, reply("id-a", "id-b", "id-a"))
		asks.onMessage(one.address, reply("id-c"))

		assertEquals(listOf(one.address to "id-a", one.address to "id-b"), opened)
		val answered = asks.requests.value.getValue(one.address)
		assertTrue(landsOnWindows(answered))
		asks.landed(answered)
		assertFalse(landsOnWindows(asks.requests.value.getValue(one.address)))
	}

	@Test
	fun `the owner's own message, a peer's, a status row, an early one, and another session's reply answer nothing`() = runBlocking {
		asks.ask(one, MODULE, "windows")

		asks.onMessage(one.address, reply("id-a", fromMe = true))
		asks.onMessage(one.address, reply("id-a").copy(isPeer = true))
		asks.onMessage(one.address, reply("id-a").copy(status = "running"))
		asks.onMessage(one.address, reply("id-a", at = clock - WINDOWS_ASK_SKEW_MS - 1))
		asks.onMessage("home.sakura.host.bbb", reply("id-a"))

		assertTrue(opened.isEmpty())
		assertNull(asks.requests.value.getValue(one.address).opened)
	}

	@Test
	fun `a reply whose windows all refuse leaves the ask waiting for the next one`() = runBlocking {
		asks.ask(one, MODULE, "windows")
		refused += "id-gone"

		asks.onMessage(one.address, reply("id-gone"))
		assertNull(asks.requests.value.getValue(one.address).opened)

		asks.onMessage(one.address, reply("id-a"))
		assertEquals(listOf(one.address to "id-a"), opened)
	}

	@Test
	fun `a send that fails drops the ask, and a second ask while one is sending keeps the first`() = runBlocking {
		host.sends = false
		assertEquals(Submitted.Failed, asks.ask(one, MODULE, "windows"))
		assertNull(asks.requests.value[one.address])

		host.sends = true
		val hold = TestHold().also { host.holds += it }
		val first = async { asks.ask(one, MODULE, "first") }
		hold.entered.await()
		assertEquals(Submitted.AlreadySending, asks.ask(one, MODULE, "second"))
		assertEquals("first", asks.requests.value.getValue(one.address).text)

		hold.release()
		assertEquals(Submitted.Sent, first.await())
		asks.dismiss(one)
		assertNull(asks.requests.value[one.address])
	}

	@Test
	fun `a window names its container before the member`() {
		val descriptor = WindowDescriptor("id", MODULE, "weekdays", 50, 51, "h", container = "RoutineSchema")

		assertEquals("RoutineSchema : weekdays", windowTitle(descriptor))
		assertEquals("weekdays", windowTitle(descriptor.copy(container = null)))
	}
}
