package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.ContentKeyring
import com.atelier_nyaarium.switchboard.crypto.Crypto
import com.atelier_nyaarium.switchboard.proto.VaultListResult
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.vault.ApprovalGate
import com.atelier_nyaarium.switchboard.vault.EntryAnswered
import com.atelier_nyaarium.switchboard.vault.NewSecretSeed
import com.atelier_nyaarium.switchboard.vault.Presence
import com.atelier_nyaarium.switchboard.vault.SavedAnswer
import com.atelier_nyaarium.switchboard.vault.VaultDraft
import com.atelier_nyaarium.switchboard.vault.VaultManager
import com.atelier_nyaarium.switchboard.vault.VaultRouterWriter
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import com.atelier_nyaarium.switchboard.vault.VaultStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SandboxVaultTest {
	@Test
	fun aSavedFormEntryIsHeldBeforeTheSandboxAnswers() = runBlocking {
		val owner = Crypto.generateIdentity()
		val manager = VaultManager(MemoryStore())
		val sealing = VaultSealing(
			testBootstrap(domainId = "domain", owner = owner, contentKeyring = ContentKeyring().also { it.deriveOwned(owner, "domain", 1) }),
			testAmbient(nonceBytes = ByteArray(12) { 1 }),
		) {}
		val sandboxWriter = VaultRouterWriter { body, _ -> sandboxVaultOwnerOp(manager, body, 50L) }
		val approvalGate = ApprovalGate(
			policy = { "off" },
			persist = {},
			authenticate = { _, _, _ -> OwnerPrompt.PASSED },
			lockOn = { false },
			unlocked = { true },
			lockEpoch = { 0 },
			elapsed = { 50L },
		)
		val collaborators = object : VaultOpsCollaborators {
			override val vault = manager
			override val writer = sandboxWriter
			override fun sealing() = sealing
			override val client: ConsoleClient? = null
			override val gate = approvalGate
		}
		val state = MutableStateFlow(ChatState())
		val ops = VaultOps(
			state = state,
			repoScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
			collaborators = collaborators,
			provision = ProvisionFence(),
			valueAnswer = ::sandboxVaultAnswer,
			now = { 50L },
		)
		manager.applyList(VaultListResult(0L, 0L, emptyList()), manager.generation)
		val request = VaultRequest.Typed(
			v = 1L,
			requestId = "request",
			operation = "sudo apt install sample",
			displayShape = "sudo apt",
			coveredShapes = listOf("sudo apt"),
			sessionTarget = "host",
			deadlineAt = Long.MAX_VALUE,
		)
		assertTrue(manager.addRequest("domain.gateway.host", request, 1L))

		val result = ops.saveAndAnswer(
			manager.request(request.requestId)!!,
			VaultDraft(privateTitle = "Sandbox secret", value = "fixture secret", gateways = listOf("gateway")),
			NewSecretSeed("fixture secret", "gateway", "saved-secret", "saved-policy"),
		) { Presence.NotOwed }

		assertTrue(result is SavedAnswer.Saved && result.answered is EntryAnswered.Answered)
		assertEquals("saved-secret", (result as SavedAnswer.Saved).entryId)
		assertNotNull(manager.stored("saved-secret"))
		assertTrue(manager.view(manager.stored("saved-secret")!!, sealing)!!.hasValue)
	}

	private class MemoryStore : VaultStore {
		override fun loadVault(): String? = null
		override fun saveVault(json: String) = Unit
	}
}
