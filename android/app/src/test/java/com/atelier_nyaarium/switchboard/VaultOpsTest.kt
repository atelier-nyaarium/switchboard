package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.vault.ApprovalGate
import com.atelier_nyaarium.switchboard.vault.VaultManager
import com.atelier_nyaarium.switchboard.vault.VaultRouterWriter
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import com.atelier_nyaarium.switchboard.vault.VaultStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VaultOpsTest {
	@Test
	fun routerNonDeliveryKeepsTheVaultCardUntilAnswered() = runBlocking {
		val manager = VaultManager(MemoryStore())
		val request = request()
		assertTrue(manager.addRequest("domain.gateway.spawn", request))
		val answers = listOf(
			ConsoleClient.ValueAnswer.Undelivered("no holder"),
			ConsoleClient.ValueAnswer.Answered(buildJsonObject { put("ok", true) }),
		)
		var calls = 0
		val ops = ops(manager) { _, _ -> answers[calls++] }
		val pending = manager.request(request.requestId)!!

		assertFalse(ops.answer(pending, "deny"))
		assertTrue(manager.request(request.requestId) != null)
		assertTrue(ops.answer(pending, "deny"))
		assertNull(manager.request(request.requestId))
	}

	@Test
	fun aGatewayRefusalSettlesTheVaultCardWithItsReason() = runBlocking {
		val manager = VaultManager(MemoryStore())
		val request = request()
		assertTrue(manager.addRequest("domain.gateway.spawn", request))
		val state = MutableStateFlow(ChatState())
		val ops = ops(manager, state) { _, _ -> ConsoleClient.ValueAnswer.Refused("policy changed") }
		val pending = manager.request(request.requestId)!!

		assertFalse(ops.answer(pending, "deny"))
		assertNull(manager.request(request.requestId))
		assertEquals("Vault: policy changed", state.value.error)
	}

	private fun ops(
		manager: VaultManager,
		state: MutableStateFlow<ChatState> = MutableStateFlow(ChatState()),
		valueAnswer: suspend (String, ConsoleOp) -> ConsoleClient.ValueAnswer,
	) = VaultOps(
		state = state,
		repoScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
		collaborators = TestCollaborators(manager),
		valueAnswer = valueAnswer,
	)

	private fun request() = VaultRequest.Typed(
		v = 1L,
		requestId = "vault-answer-123",
		operation = "sudo apt",
		displayShape = "sudo apt",
		coveredShapes = listOf("sudo apt"),
		sessionTarget = "host.assistant",
		deadlineAt = System.currentTimeMillis() + 60_000L,
	)

	private class MemoryStore : VaultStore {
		var raw: String? = null
		override fun loadVault(): String? = raw
		override fun saveVault(json: String) { raw = json }
	}

	private class TestCollaborators(override val vault: VaultManager) : VaultOpsCollaborators {
		override val writer = VaultRouterWriter { _, _ -> buildJsonObject {} }
		override fun sealing(): VaultSealing? = null
		override val client: ConsoleClient? = null
		override val gate = ApprovalGate({ "off" }, {}, { false }, { true })
	}
}
