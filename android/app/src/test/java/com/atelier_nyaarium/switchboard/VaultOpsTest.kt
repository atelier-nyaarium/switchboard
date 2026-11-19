package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.vault.ApprovalGate
import com.atelier_nyaarium.switchboard.vault.EntryAnswered
import com.atelier_nyaarium.switchboard.vault.SavedAnswer
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_ONCE
import com.atelier_nyaarium.switchboard.vault.VaultDraft
import com.atelier_nyaarium.switchboard.vault.VaultManager
import com.atelier_nyaarium.switchboard.vault.VaultRouterWriter
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import com.atelier_nyaarium.switchboard.vault.VaultStore
import com.atelier_nyaarium.switchboard.vault.entryAnswerOp
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
		assertTrue(state.value.notices.single().text.contains("policy changed"))
	}

	@Test
	fun anEntryAnswerSettlesOnlyWhenTheRequestEnded() = runBlocking {
		val manager = VaultManager(MemoryStore())
		val state = MutableStateFlow(ChatState())
		val sent = mutableListOf<ConsoleOp>()
		val replies = ArrayDeque(
			listOf(
				buildJsonObject {
					put("ok", false)
					put("refusal", buildJsonObject { put("code", "unusable"); put("unusable", "empty") })
				},
				buildJsonObject {
					put("ok", false)
					put("refusal", buildJsonObject { put("code", "expired") })
				},
			),
		)
		val ops = ops(manager, state) { _, op -> sent += op; ConsoleClient.ValueAnswer.Answered(replies.removeFirst()) }
		assertTrue(manager.addRequest(TEAM, request()))
		val pending = manager.request(request().requestId)!!
		val op = entryAnswerOp(pending.requestId, "nyaarium", VAULT_DECISION_ONCE, null)!!

		assertTrue(ops.answerWithEntry(pending, op) is EntryAnswered.Stays)
		assertTrue(manager.request(pending.requestId) != null)
		assertTrue(ops.answerWithEntry(pending, op) is EntryAnswered.Gone)
		assertNull(manager.request(pending.requestId))
		assertEquals(listOf<ConsoleOp>(op, op), sent)
	}

	@Test
	fun anAnswerTheGatewayAlreadyHadDropsTheCardSilently() = runBlocking {
		val manager = VaultManager(MemoryStore())
		val state = MutableStateFlow(ChatState())
		val answered = buildJsonObject {
			put("ok", false)
			put("refusal", buildJsonObject { put("code", "answered") })
		}
		val ops = ops(manager, state) { _, _ -> ConsoleClient.ValueAnswer.Answered(answered) }
		assertTrue(manager.addRequest(TEAM, request()))
		val pending = manager.request(request().requestId)!!

		ops.answerWithEntry(pending, entryAnswerOp(pending.requestId, "nyaarium", VAULT_DECISION_ONCE, null)!!)

		assertNull(manager.request(pending.requestId))
		assertTrue(state.value.notices.isEmpty())
	}

	@Test
	fun aTypedAnswerTheGatewayAlreadyHadDropsTheCardSilently() = runBlocking {
		val manager = VaultManager(MemoryStore())
		val state = MutableStateFlow(ChatState())
		val answered = buildJsonObject {
			put("ok", false)
			put("reason", "already answered")
			put("refusal", buildJsonObject { put("code", "answered") })
		}
		val ops = ops(manager, state) { _, _ -> ConsoleClient.ValueAnswer.Answered(answered) }
		assertTrue(manager.addRequest(TEAM, request()))

		assertFalse(ops.answer(manager.request(request().requestId)!!, "deny"))
		assertNull(manager.request(request().requestId))
		assertTrue(state.value.notices.isEmpty())
	}

	@Test
	fun aSaveThatDidNotLandAnswersNothing() = runBlocking {
		val manager = VaultManager(MemoryStore())
		val sent = mutableListOf<ConsoleOp>()
		val ops = ops(manager) { _, op -> sent += op; ConsoleClient.ValueAnswer.Unreachable }
		assertTrue(manager.addRequest(TEAM, request()))
		val pending = manager.request(request().requestId)!!

		val saved = ops.saveAndAnswer(pending, VaultDraft(privateTitle = "Sakura Nyaarium", value = "hunter3", gateways = listOf("gateway")))

		assertTrue(saved is SavedAnswer.NotSaved)
		assertTrue(sent.isEmpty())
		assertTrue(manager.live().isEmpty())
		assertTrue(manager.request(pending.requestId) != null)
	}

	@Test
	fun aTakeoverReplacesTheTypedCard() {
		val manager = VaultManager(MemoryStore())
		assertTrue(manager.addRequest(TEAM, request()))
		val takeover = VaultRequest.Entry(
			entryId = "nyaarium",
			v = 1L,
			requestId = "vault-answer-456",
			operation = "sudo apt",
			displayShape = "sudo apt",
			coveredShapes = listOf("sudo apt"),
			sessionTarget = "host.assistant",
			deadlineAt = System.currentTimeMillis() + 60_000L,
			replaces = request().requestId,
		)

		assertTrue(manager.addRequest(TEAM, takeover))
		assertEquals(listOf("vault-answer-456"), manager.pending.value.map { it.requestId })
	}

	private fun ops(
		manager: VaultManager,
		state: MutableStateFlow<ChatState> = MutableStateFlow(ChatState()),
		valueAnswer: suspend (String, ConsoleOp) -> ConsoleClient.ValueAnswer,
	) = VaultOps(
		state = state,
		repoScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
		collaborators = TestCollaborators(manager),
		provision = ProvisionFence(),
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

	private companion object {
		const val TEAM = "domain.gateway.spawn"
	}

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
