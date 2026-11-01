package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConsoleClient
import com.atelier_nyaarium.switchboard.proto.AssistantSendIntent
import com.atelier_nyaarium.switchboard.proto.AssistantSendRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantSendOpsTest {
	@Test
	fun routerNonDeliveryKeepsTheSendCardUntilAnswered() = runBlocking {
		val manager = AssistantSendManager(MemoryStore())
		val request = sendRequest()
		assertTrue(manager.onRequest("gateway-a", "host.assistant", request))
		val answers = listOf(
			ConsoleClient.ValueAnswer.Undelivered("no holder"),
			ConsoleClient.ValueAnswer.Answered(buildJsonObject { put("ok", true) }),
		)
		var calls = 0
		val ops = AssistantSendOps(MutableStateFlow(ChatState()), manager) { _, _ -> answers[calls++] }
		val pending = ops.request("gateway-a", request.requestId)!!

		assertEquals(AssistantSendAnswer.Unreachable, ops.answer(pending, "approve"))
		assertTrue(ops.request("gateway-a", request.requestId) != null)
		assertEquals(AssistantSendAnswer.Answered, ops.answer(pending, "approve"))
		assertTrue(ops.pending.value.isEmpty())
	}

	@Test
	fun aGatewayRefusalSettlesTheSendCardWithItsReason() = runBlocking {
		val manager = AssistantSendManager(MemoryStore())
		val request = sendRequest()
		assertTrue(manager.onRequest("gateway-a", "host.assistant", request))
		val state = MutableStateFlow(ChatState())
		val ops = AssistantSendOps(state, manager) { _, _ -> ConsoleClient.ValueAnswer.Refused("send disabled") }
		val pending = ops.request("gateway-a", request.requestId)!!

		assertEquals(AssistantSendAnswer.Refused("send disabled"), ops.answer(pending, "approve"))
		assertEquals("Assistant: send disabled", state.value.error)
		assertTrue(ops.pending.value.isEmpty())
	}

	private fun sendRequest() = AssistantSendRequest(
		v = 1L,
		requestId = "send-call-1234",
		sessionTarget = "host.assistant",
		deadlineAt = System.currentTimeMillis() + 60_000L,
		intent = AssistantSendIntent(
			target = "home.sakura.host.w",
			body = "message",
			createsSession = false,
			files = emptyList(),
		),
	)

	private class MemoryStore : AssistantSendStore {
		var raw: String? = null
		override fun loadAssistantSends(): String? = raw
		override fun saveAssistantSends(json: String) { raw = json }
	}
}
