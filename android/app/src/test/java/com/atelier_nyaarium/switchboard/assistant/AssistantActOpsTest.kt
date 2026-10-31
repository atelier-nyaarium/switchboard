package com.atelier_nyaarium.switchboard.assistant

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
				buildJsonObject { put("ok", true) }
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

	private class MemoryStore : AssistantActStore {
		var raw: String? = null
		override fun loadAssistantActs(): String? = raw
		override fun saveAssistantActs(json: String) { raw = json }
	}
}
