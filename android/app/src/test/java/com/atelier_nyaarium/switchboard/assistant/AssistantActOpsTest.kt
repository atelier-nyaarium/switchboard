package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.ConsoleClient
import com.atelier_nyaarium.switchboard.proto.AssistantActRequest
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantActOpsTest {
	@Test
	fun theActCardAnswersTheHeldGatewayRequest() = runBlocking {
		val store = MemoryStore()
		val manager = AssistantActManager(store)
		val request = AssistantActRequest("act-call-1234", "torch", "Torch", "Turn on", System.currentTimeMillis() + 60_000L)
		assertTrue(manager.onRequest("gateway-a", "team-a", request))
		var answered: ConsoleOp.AssistantActAnswer? = null
		var answerGateway = ""
		var answerOpId = ""
		val ops = AssistantActOps(
			manager = manager,
			ownerPresent = { true },
			send = { gateway, op, opId ->
				answerGateway = gateway
				answered = op
				answerOpId = opId
				ConsoleClient.ValueAnswer.Answered(buildJsonObject { put("ok", true) })
			},
		)

		val pending = ops.request("gateway-a", request.requestId)!!
		assertEquals(AssistantActAnswer.Answered, ops.answer(pending, "deny", "Do not run"))
		assertEquals("gateway-a", answerGateway)
		assertEquals(request.requestId, answerOpId)
		assertEquals("deny", answered?.decision)
		assertEquals("Do not run", answered?.note)
		assertTrue(ops.pending.value.isEmpty())
	}

	@Test
	fun routerNonDeliveryKeepsTheActCardUntilAnswered() = runBlocking {
		val manager = AssistantActManager(MemoryStore())
		val request = actRequest()
		assertTrue(manager.onRequest("gateway-a", "team-a", request))
		val answers = listOf(
			ConsoleClient.ValueAnswer.Undelivered("no holder"),
			ConsoleClient.ValueAnswer.Answered(buildJsonObject { put("ok", true) }),
		)
		var calls = 0
		val ops = AssistantActOps(manager, { true }) { _, _, _ -> answers[calls++] }
		val pending = ops.request("gateway-a", request.requestId)!!

		assertEquals(AssistantActAnswer.Unreachable, ops.answer(pending, "deny"))
		assertTrue(ops.request("gateway-a", request.requestId) != null)
		assertEquals(AssistantActAnswer.Answered, ops.answer(pending, "deny"))
		assertTrue(ops.pending.value.isEmpty())
	}

	@Test
	fun aGatewayRefusalSettlesTheActCardWithItsReason() = runBlocking {
		val manager = AssistantActManager(MemoryStore())
		val request = actRequest()
		assertTrue(manager.onRequest("gateway-a", "team-a", request))
		val ops = AssistantActOps(manager, { true }) { _, _, _ -> ConsoleClient.ValueAnswer.Refused("request expired") }
		val pending = ops.request("gateway-a", request.requestId)!!

		assertEquals(AssistantActAnswer.Refused("request expired"), ops.answer(pending, "deny"))
		assertTrue(ops.pending.value.isEmpty())
	}

	private fun actRequest() = AssistantActRequest(
		"act-call-1234",
		"torch",
		"Torch",
		"Turn on",
		System.currentTimeMillis() + 60_000L,
	)

	private class MemoryStore : AssistantActStore {
		var raw: String? = null
		override fun loadAssistantActs(): String? = raw
		override fun saveAssistantActs(json: String) { raw = json }
	}
}
