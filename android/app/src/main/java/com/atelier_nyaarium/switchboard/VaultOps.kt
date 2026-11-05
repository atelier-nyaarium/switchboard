package com.atelier_nyaarium.switchboard

import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.crypto.VAULT_TYPED_KIND
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultAnswerResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultGrantsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultRevokeResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import com.atelier_nyaarium.switchboard.proto.VaultPut
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import com.atelier_nyaarium.switchboard.vault.ApprovalGate
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_DENY
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_SESSION
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_WINDOW
import com.atelier_nyaarium.switchboard.vault.VaultDraft
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import com.atelier_nyaarium.switchboard.vault.VaultManager
import com.atelier_nyaarium.switchboard.vault.VaultPendingRequest
import com.atelier_nyaarium.switchboard.vault.VaultRouterWriter
import com.atelier_nyaarium.switchboard.vault.VaultSaveOutcome
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import com.atelier_nyaarium.switchboard.vault.sealDraft
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.decodeFromJsonElement

internal interface VaultOpsCollaborators {
	val vault: VaultManager
	val writer: VaultRouterWriter
	fun sealing(): VaultSealing?
	val client: ConsoleClient?
	val gate: ApprovalGate
}

/** Repository-side vault operations. */
internal class VaultOps(
	private val state: MutableStateFlow<ChatState>,
	private val repoScope: CoroutineScope,
	private val collaborators: VaultOpsCollaborators,
	private val valueAnswer: (suspend (String, ConsoleOp) -> ConsoleClient.ValueAnswer)? = null,
) {
	private val manager get() = collaborators.vault

	// One list in flight, so answers land in order.
	private val refreshMutex = Mutex()

	/** A plane bump the socket pushed is not re-offered, so a failed list retries here. */
	fun refresh() {
		repoScope.launch {
			for (delayMs in REFRESH_RETRY_DELAYS_MS) {
				if (refreshNow()) return@launch
				delay(delayMs)
			}
			refreshNow()
		}
	}

	/** Lists after the held revision, and again from zero when the Router fell behind. */
	suspend fun refreshNow(): Boolean = refreshMutex.withLock {
		manager.sweepRequests()
		val generation = manager.generation
		val since = manager.routerRevision.takeIf { it > 0 }
		val first = list(since) ?: return false
		if (manager.applyList(first, generation = generation)) return true
		if (since == null) return false
		val full = list(null) ?: return false
		manager.applyList(full, generation = generation)
	}

	private suspend fun list(since: Long?) =
		runCatchingCancellable { collaborators.writer.list(since, newOpId()) }
			.onFailure { DebugLog.log("Vault", "list failed: ${it.message?.take(80)}") }
			.getOrNull()

	fun views(): List<VaultEntryView> = collaborators.sealing()?.let { manager.views(it) } ?: emptyList()

	fun view(id: String): VaultEntryView? {
		val sealing = collaborators.sealing() ?: return null
		return manager.stored(id)?.let { manager.view(it, sealing) }
	}

	fun stored(id: String): VaultStoredEntry? = manager.stored(id)

	fun reveal(id: String): String? {
		val sealing = collaborators.sealing() ?: return null
		return manager.stored(id)?.let { manager.openValue(it, sealing) }
	}

	suspend fun save(draft: VaultDraft): VaultSaveOutcome {
		val sealing = collaborators.sealing() ?: return VaultSaveOutcome.Unreachable
		val existing = draft.id?.let { manager.stored(it) }
		val opened = existing?.let { manager.view(it, sealing) }
		val id = draft.id ?: newEntryId()
		val generation = manager.generation
		val sealed = sealDraft(draft, id, existing, opened, sealing) ?: return VaultSaveOutcome.Unreachable
		if (sealed.publicTitle == null && sealed.privateTitle == null) return VaultSaveOutcome.Refused("untitled")
		val put = VaultPut(id = id, expectedRevision = existing?.clear?.revision ?: 0L, sealed = sealed)
		val result = runCatchingCancellable { collaborators.writer.put(put, newOpId()) }
			.onFailure { DebugLog.log("Vault", "put failed: ${it.message?.take(80)}") }
			.getOrNull() ?: return VaultSaveOutcome.Unreachable
		result.entry?.let { if (!manager.applyWrite(it, result.revision, generation = generation)) refresh() }
		return when (result.outcome) {
			"applied" -> VaultSaveOutcome.Applied(id)
			"conflict" -> VaultSaveOutcome.Conflict
			else -> VaultSaveOutcome.Refused(result.refusal ?: Protocol.Wire.SocketFrame.REFUSED)
		}
	}

	suspend fun delete(id: String): VaultSaveOutcome {
		val existing = manager.stored(id) ?: return VaultSaveOutcome.Refused("entry_missing")
		val generation = manager.generation
		val result = runCatchingCancellable { collaborators.writer.delete(id, existing.clear.revision, newOpId()) }
			.onFailure { DebugLog.log("Vault", "delete failed: ${it.message?.take(80)}") }
			.getOrNull() ?: return VaultSaveOutcome.Unreachable
		result.entry?.let { if (!manager.applyWrite(it, result.revision, generation = generation)) refresh() }
		return when (result.outcome) {
			"applied" -> VaultSaveOutcome.Applied(id)
			"conflict" -> VaultSaveOutcome.Conflict
			else -> VaultSaveOutcome.Refused(result.refusal ?: Protocol.Wire.SocketFrame.REFUSED)
		}
	}

	/** The plugin's handler; duplicates are dropped by the manager. An unstored one is logged there. */
	fun onRequest(team: String, request: VaultRequest) {
		manager.addRequest(team, request)
	}

	fun pendingRequest(requestId: String): VaultPendingRequest? = manager.request(requestId)

	suspend fun ownerPresent(activity: FragmentActivity?): Boolean = collaborators.gate.require(activity)

	/**
	 * Answers one request; a typed value seals under the request id, and a deny may carry a steering
	 * note. Runs on the repository's scope, so closing the card that asked cannot cut it short.
	 */
	suspend fun answer(
		pending: VaultPendingRequest,
		decision: String,
		typedValue: String? = null,
		note: String? = null,
		/** Also store the typed value as an entry, scoped to the gateway that asked. */
		saveTyped: Boolean = false,
	): Boolean = repoScope.async {
		val ok = answerNow(pending, decision, typedValue, note)
		if (ok && saveTyped && typedValue != null) {
			val gateway = runIsolated { gatewayOf(pending.team) }.getOrNull()
			save(VaultDraft(publicTitle = pending.displayShape, value = typedValue, gateways = listOfNotNull(gateway)))
		}
		ok
	}.await()

	private suspend fun answerNow(
		pending: VaultPendingRequest,
		decision: String,
		typedValue: String?,
		note: String?,
	): Boolean {
		val client = collaborators.client
		if (client == null && valueAnswer == null) return false.also { report("Vault: not connected") }
		val value = typedValue?.let { text ->
			collaborators.sealing()?.seal(text, VAULT_TYPED_KIND, pending.requestId)
				?: return false.also { report("Vault: no content key to seal the value") }
		}
		val gatewayId = runIsolated { gatewayOf(pending.team) }.getOrNull()
			?: return false.also { report("Vault: the request names no gateway") }
		val op = ConsoleOp.VaultAnswer(pending.requestId, decision, value, note?.trim()?.ifEmpty { null })
		val answer = runCatchingCancellable {
			valueAnswer?.invoke(gatewayId, op) ?: client?.sendValueAnswer(gatewayId, op) ?: ConsoleClient.ValueAnswer.Unreachable
		}.onFailure { DebugLog.log("Vault", "answer failed: ${it.message?.take(80)}") }.getOrNull()
			?: return false.also { report("Vault: the gateway could not be reached") }
		if (!answerDeliverySettled(answer)) {
			when (answer) {
				is ConsoleClient.ValueAnswer.Undelivered -> report("Vault: the Router did not deliver the answer: ${answer.reason}")
				ConsoleClient.ValueAnswer.Unreachable -> report("Vault: the gateway could not be reached")
				else -> Unit
			}
			return false
		}
		manager.settleRequest(pending.requestId)
		if (answer is ConsoleClient.ValueAnswer.Refused) {
			report("Vault: ${answer.reason}")
			return false
		}
		if (answer !is ConsoleClient.ValueAnswer.Answered) return false
		val result = runIsolated {
			wireJson.decodeFromJsonElement<ConsoleVaultAnswerResult>(answer.result)
		}.getOrNull() ?: return false.also { report("Vault: the answer could not be read") }
		if (result.ok) {
			if (decision != VAULT_DECISION_DENY) manager.recordAnswer(pending)
		} else {
			report("Vault: ${result.reason ?: "the answer was refused"}")
		}
		if (result.ok && decision != VAULT_DECISION_DENY) refreshGrantsNow(gatewayId)
		return result.ok
	}

	fun refreshGrants() {
		repoScope.launch { refreshGrantsNow() }
	}

	suspend fun refreshGrantsNow(only: String? = null) {
		val client = collaborators.client ?: return
		for (gatewayId in state.value.gateways.ids().filter { only == null || it == only }) {
			val result = runCatchingCancellable {
				client.valueResult<ConsoleVaultGrantsResult>(client.sendValueOp(gatewayId, ConsoleOp.VaultGrants), "vault_grants")
			}.getOrNull() ?: continue
			manager.setGrants(gatewayId, result.grants)
		}
	}

	suspend fun revoke(gatewayId: String, grantId: String): Boolean {
		val client = collaborators.client ?: return false
		// Revocation requires the current roster.
		val registry = state.value.gateways
		if (!registry.current || !registry.has(gatewayId)) return false
		val result = runCatchingCancellable {
			client.valueResult<ConsoleVaultRevokeResult>(client.sendValueOp(gatewayId, ConsoleOp.VaultRevoke(grantId)), "vault_revoke")
		}.getOrNull() ?: return false
		refreshGrantsNow(gatewayId)
		return result.revoked
	}

	/** The strongest grant tier a session holds, or null. */
	fun grantTierFor(team: String): String? {
		val held = grantsHeldBy(manager.grants.value, team)
		return when {
			held.any { it is VaultGrant.Session } -> VAULT_DECISION_SESSION
			held.any { it is VaultGrant.Window } -> VAULT_DECISION_WINDOW
			else -> null
		}
	}

	private fun report(message: String) {
		state.update { it.copy(error = message) }
	}

	private fun newOpId(): String = UUID.randomUUID().toString()

	private fun newEntryId(): String = UUID.randomUUID().toString().replace("-", "").take(32)

	private companion object {
		val REFRESH_RETRY_DELAYS_MS = listOf(5_000L, 30_000L)
	}
}
