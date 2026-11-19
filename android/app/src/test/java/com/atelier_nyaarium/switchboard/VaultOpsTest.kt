package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.PolicyRef
import com.atelier_nyaarium.switchboard.proto.VaultAnswering
import com.atelier_nyaarium.switchboard.proto.VaultEntryClear
import com.atelier_nyaarium.switchboard.proto.VaultListResult
import com.atelier_nyaarium.switchboard.proto.VaultPut
import com.atelier_nyaarium.switchboard.proto.VaultRemember
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import com.atelier_nyaarium.switchboard.proto.VaultTypedWhy
import com.atelier_nyaarium.switchboard.proto.VaultWriteResult
import com.atelier_nyaarium.switchboard.vault.ApprovalGate
import com.atelier_nyaarium.switchboard.vault.EntryAnswered
import com.atelier_nyaarium.switchboard.vault.NewSecretSeed
import com.atelier_nyaarium.switchboard.vault.SavedAnswer
import com.atelier_nyaarium.switchboard.vault.TypedSave
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VaultOpsTest {
	private val sudo = PolicyRef("sakura-sudo", 2L)

	@Test
	fun routerNonDeliveryKeepsTheVaultCardUntilAnswered() = runBlocking {
		val world = World()
		val request = typed()
		assertTrue(world.manager.addRequest(TEAM, request))
		val answers = listOf(
			ConsoleClient.ValueAnswer.Undelivered("no holder"),
			ConsoleClient.ValueAnswer.Answered(buildJsonObject { put("ok", true) }),
		)
		var calls = 0
		val ops = world.ops { _, _ -> answers[calls++] }
		val pending = world.manager.request(request.requestId)!!

		assertFalse(ops.answer(pending, "deny", { true }))
		assertTrue(world.manager.request(request.requestId) != null)
		assertTrue(ops.answer(pending, "deny", { true }))
		assertNull(world.manager.request(request.requestId))
	}

	@Test
	fun aGatewayRefusalSettlesTheVaultCardWithItsReason() = runBlocking {
		val world = World()
		assertTrue(world.manager.addRequest(TEAM, typed()))
		val ops = world.ops { _, _ -> ConsoleClient.ValueAnswer.Refused("policy changed") }

		assertFalse(ops.answer(world.manager.request(typed().requestId)!!, "deny", { true }))
		assertNull(world.manager.request(typed().requestId))
		assertTrue(world.state.value.notices.single().text.contains("policy changed"))
	}

	@Test
	fun withoutPresenceNoApprovalOfAnEntryIsSentRevealedOrSaved() = runBlocking {
		val world = World()
		world.hold("nyaarium", "Sakura Nyaarium", "hunter3")
		world.listed()
		val sent = mutableListOf<ConsoleOp>()
		val ops = world.ops { _, op -> sent += op; ConsoleClient.ValueAnswer.Answered(buildJsonObject { put("ok", true) }) }
		val entry = VaultRequest.Entry(
			entryId = "nyaarium",
			v = 1L,
			requestId = "vault-entry-1",
			operation = "sudo apt",
			displayShape = "sudo apt",
			coveredShapes = listOf("sudo apt"),
			sessionTarget = "host.assistant",
			deadlineAt = System.currentTimeMillis() + 60_000L,
		)
		assertTrue(world.manager.addRequest(TEAM, typed()))
		assertTrue(world.manager.addRequest(TEAM, entry))
		val typedCard = world.manager.request(typed().requestId)!!
		val entryCard = world.manager.request(entry.requestId)!!
		val absent: suspend () -> Boolean = { false }
		val puts = world.puts

		assertFalse(ops.answer(entryCard, VAULT_DECISION_ONCE, absent))
		assertEquals(EntryAnswered.Declined, ops.answerWithEntry(typedCard, entryAnswerOp(typedCard.requestId, "nyaarium", VAULT_DECISION_ONCE, null)!!, absent))
		assertEquals(TypedSave.Declined, ops.saveTyped(typedCard, "hunter3", absent))
		val draft = VaultDraft(privateTitle = "New", value = "fresh", gateways = listOf(GATEWAY))
		assertEquals(SavedAnswer.Declined, ops.saveAndAnswer(typedCard, draft, seed("fresh"), absent))

		assertTrue(sent.isEmpty())
		assertEquals(puts, world.puts)
		assertEquals(2, world.manager.pending.value.size)
		// A deny needs no presence.
		assertTrue(ops.answer(entryCard, "deny", absent))
	}

	@Test
	fun aTypedValueMatchesTheAnsweringSecretBeforeAnyOther() = runBlocking {
		val world = World()
		world.hold("a-twin", "A twin", "hunter3")
		world.hold("nyaarium", "Sakura Nyaarium", "hunter3")
		val ops = world.ops { _, _ -> ConsoleClient.ValueAnswer.Unreachable }
		val answered = typed(answering = listOf(VaultAnswering("nyaarium", sudo)))
		assertTrue(world.manager.addRequest(TEAM, answered))
		val card = world.manager.request(answered.requestId)!!

		// Unlisted: no match is trusted.
		assertTrue(ops.saveTyped(card, "hunter3") { true } is TypedSave.Refused)
		world.listed()
		assertEquals(TypedSave.Matched("nyaarium"), ops.saveTyped(card, "hunter3") { true })

		val bare = typed(id = "vault-answer-2")
		assertTrue(world.manager.addRequest(TEAM, bare))
		assertEquals(TypedSave.Matched("a-twin"), ops.saveTyped(world.manager.request(bare.requestId)!!, "hunter3") { true })

		val form = ops.saveTyped(card, "unheld") { true }
		assertTrue(form is TypedSave.Form)
		assertEquals(GATEWAY, (form as TypedSave.Form).seed.gatewayId)
		assertEquals("unheld", form.seed.value)
	}

	@Test
	fun aRetriedSaveMakesNoTwin() = runBlocking {
		val world = World()
		world.listed()
		val sent = mutableListOf<ConsoleOp>()
		val ops = world.ops { _, op -> sent += op; ConsoleClient.ValueAnswer.Undelivered("no holder") }
		assertTrue(world.manager.addRequest(TEAM, typed()))
		val card = world.manager.request(typed().requestId)!!
		val seed = seed("hunter3")
		val draft = VaultDraft(privateTitle = "Sakura Nyaarium", value = "hunter3", gateways = listOf(GATEWAY))

		val first = ops.saveAndAnswer(card, draft, seed) { true }
		assertTrue(first is SavedAnswer.Saved && first.answered is EntryAnswered.Stays)
		assertEquals(seed.entryId, (first as SavedAnswer.Saved).entryId)
		val op = sent.single() as ConsoleOp.VaultAnswerEntry
		assertEquals(VaultRemember(seed.policyId, name = "Sakura Nyaarium"), op.remember)

		// Saved and held: the retry lands on it.
		assertEquals(SavedAnswer.Matched(seed.entryId), ops.saveAndAnswer(card, draft, seed) { true })
		assertEquals(listOf(seed.entryId), world.router.keys.toList())

		// Saved, answer lost: the retry is refused, not doubled.
		val lost = World(loseAnswers = true)
		lost.listed()
		assertTrue(lost.manager.addRequest(TEAM, typed()))
		val lostCard = lost.manager.request(typed().requestId)!!
		val lostOps = lost.ops { _, _ -> ConsoleClient.ValueAnswer.Unreachable }
		assertTrue(lostOps.saveAndAnswer(lostCard, draft, seed) { true } is SavedAnswer.NotSaved)
		assertTrue(lostOps.saveAndAnswer(lostCard, draft, seed) { true } is SavedAnswer.NotSaved)
		assertEquals(listOf(seed.entryId), lost.router.keys.toList())
	}

	@Test
	fun theFormsFinalValueIsMatchedBeforeItWrites() = runBlocking {
		val world = World()
		world.hold("nyaarium", "Sakura Nyaarium", "hunter3")
		world.listed()
		val ops = world.ops { _, _ -> error("not asked") }
		assertTrue(world.manager.addRequest(TEAM, typed()))
		val card = world.manager.request(typed().requestId)!!
		val puts = world.puts

		val saved = ops.saveAndAnswer(card, VaultDraft(privateTitle = "Edited", value = "hunter3", gateways = listOf(GATEWAY)), seed("typo")) { true }

		assertEquals(SavedAnswer.Matched("nyaarium"), saved)
		assertEquals(puts, world.puts)
	}

	@Test
	fun anEntryAnswerSettlesOnlyWhenTheRequestEnded() = runBlocking {
		val world = World()
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
		val ops = world.ops { _, op -> sent += op; ConsoleClient.ValueAnswer.Answered(replies.removeFirst()) }
		assertTrue(world.manager.addRequest(TEAM, typed()))
		val pending = world.manager.request(typed().requestId)!!
		val op = entryAnswerOp(pending.requestId, "nyaarium", VAULT_DECISION_ONCE, null)!!

		assertTrue(ops.answerWithEntry(pending, op) { true } is EntryAnswered.Stays)
		assertTrue(world.manager.request(pending.requestId) != null)
		assertTrue(ops.answerWithEntry(pending, op) { true } is EntryAnswered.Gone)
		assertNull(world.manager.request(pending.requestId))
		assertEquals(listOf<ConsoleOp>(op, op), sent)
	}

	@Test
	fun anAnswerTheGatewayAlreadyHadDropsTheCardSilently() = runBlocking {
		val world = World()
		val answered = buildJsonObject {
			put("ok", false)
			put("reason", "already answered")
			put("refusal", buildJsonObject { put("code", "answered") })
		}
		val ops = world.ops { _, _ -> ConsoleClient.ValueAnswer.Answered(answered) }
		assertTrue(world.manager.addRequest(TEAM, typed()))
		val pending = world.manager.request(typed().requestId)!!
		ops.answerWithEntry(pending, entryAnswerOp(pending.requestId, "nyaarium", VAULT_DECISION_ONCE, null)!!) { true }
		assertNull(world.manager.request(pending.requestId))

		assertTrue(world.manager.addRequest(TEAM, typed(id = "vault-answer-2")))
		assertFalse(ops.answer(world.manager.request("vault-answer-2")!!, "deny", { true }))
		assertNull(world.manager.request("vault-answer-2"))
		assertTrue(world.state.value.notices.isEmpty())
	}

	@Test
	fun aTakeoverReplacesTheTypedCard() {
		val manager = VaultManager(MemoryStore())
		assertTrue(manager.addRequest(TEAM, typed()))
		val takeover = VaultRequest.Entry(
			entryId = "nyaarium",
			v = 1L,
			requestId = "vault-answer-456",
			operation = "sudo apt",
			displayShape = "sudo apt",
			coveredShapes = listOf("sudo apt"),
			sessionTarget = "host.assistant",
			deadlineAt = System.currentTimeMillis() + 60_000L,
			replaces = typed().requestId,
		)

		assertTrue(manager.addRequest(TEAM, takeover))
		assertEquals(listOf("vault-answer-456"), manager.pending.value.map { it.requestId })
	}

	private fun seed(value: String) = NewSecretSeed(value, GATEWAY, "seed-entry", "seed-policy")

	private fun typed(answering: List<VaultAnswering>? = null, id: String = "vault-answer-123") = VaultRequest.Typed(
		v = 1L,
		requestId = id,
		operation = "sudo apt",
		displayShape = "sudo apt",
		coveredShapes = listOf("sudo apt"),
		sessionTarget = "host.assistant",
		deadlineAt = System.currentTimeMillis() + 60_000L,
		why = VaultTypedWhy("no_policy"),
		answering = answering,
	)

	/** A phone over a fake Router vault. */
	private class World(loseAnswers: Boolean = false) {
		val manager = VaultManager(MemoryStore())
		val state = MutableStateFlow(ChatState())
		val router = LinkedHashMap<String, VaultStoredEntry>()
		var puts = 0
		private val owner = Crypto.generateIdentity()
		private val sealing = VaultSealing(
			testBootstrap(domainId = "domain", owner = owner, contentKeyring = ContentKeyring().also { it.deriveOwned(owner, "domain", 1) }),
			testAmbient(nonceBytes = ByteArray(12) { 1 }),
		) {}
		private val writer = VaultRouterWriter { body, _ ->
			val put = wireJson.decodeFromJsonElement(VaultPut.serializer(), body.jsonObject["put"]!!)
			val held = router[put.id]
			val result = if ((held?.clear?.revision ?: 0L) != put.expectedRevision) {
				VaultWriteResult(outcome = "conflict", revision = router.size.toLong())
			} else {
				puts++
				val entry = VaultStoredEntry(VaultEntryClear(put.id, put.expectedRevision + 1, false, puts.toLong(), "phone", 0L, 0L), put.sealed)
				router[put.id] = entry
				VaultWriteResult(outcome = "applied", revision = puts.toLong(), entry = entry)
			}
			if (loseAnswers) error("answer lost")
			wireJson.encodeToJsonElement(VaultWriteResult.serializer(), result)
		}
		private val collaborators = object : VaultOpsCollaborators {
			override val vault = manager
			override val writer = this@World.writer
			override fun sealing(): VaultSealing = this@World.sealing
			override val client: ConsoleClient? = null
			override val gate = ApprovalGate({ "off" }, {}, { false }, { true })
		}

		fun ops(valueAnswer: suspend (String, ConsoleOp) -> ConsoleClient.ValueAnswer) = VaultOps(
			state = state,
			repoScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
			collaborators = collaborators,
			provision = ProvisionFence(),
			valueAnswer = valueAnswer,
			matching = Dispatchers.Unconfined,
		)

		suspend fun hold(id: String, title: String, value: String) {
			ops { _, _ -> ConsoleClient.ValueAnswer.Unreachable }.save(VaultDraft(id = id, privateTitle = title, value = value, gateways = listOf(GATEWAY)))
		}

		fun listed() {
			manager.applyList(VaultListResult(puts.toLong(), 0L, router.values.toList()), generation = manager.generation)
		}
	}

	private companion object {
		const val TEAM = "domain.gateway.spawn"
		const val GATEWAY = "gateway"
	}

	private class MemoryStore : VaultStore {
		var raw: String? = null
		override fun loadVault(): String? = raw
		override fun saveVault(json: String) { raw = json }
	}
}
