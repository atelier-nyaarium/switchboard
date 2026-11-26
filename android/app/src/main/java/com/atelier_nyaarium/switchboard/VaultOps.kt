package com.atelier_nyaarium.switchboard

import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.crypto.VAULT_TYPED_KIND
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.policies.PolicyDraft
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultAnswerEntryResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultAnswerResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultGrantsResult
import com.atelier_nyaarium.switchboard.proto.ConsoleVaultRevokeResult
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import com.atelier_nyaarium.switchboard.proto.VaultAnswering
import com.atelier_nyaarium.switchboard.proto.VaultPut
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.proto.VaultStoredEntry
import com.atelier_nyaarium.switchboard.vault.ApprovalGate
import com.atelier_nyaarium.switchboard.vault.EntryAnswered
import com.atelier_nyaarium.switchboard.vault.NewSecretSeed
import com.atelier_nyaarium.switchboard.vault.SavedAnswer
import com.atelier_nyaarium.switchboard.vault.SecretChoice
import com.atelier_nyaarium.switchboard.vault.TypedSave
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_DENY
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_ONCE
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_SESSION
import com.atelier_nyaarium.switchboard.vault.VAULT_DECISION_WINDOW
import com.atelier_nyaarium.switchboard.vault.VaultDraft
import com.atelier_nyaarium.switchboard.vault.VaultEntryView
import com.atelier_nyaarium.switchboard.vault.VaultManager
import com.atelier_nyaarium.switchboard.vault.VaultPendingRequest
import com.atelier_nyaarium.switchboard.vault.VaultRouterWriter
import com.atelier_nyaarium.switchboard.vault.VaultSaveOutcome
import com.atelier_nyaarium.switchboard.vault.VaultSealing
import com.atelier_nyaarium.switchboard.vault.answeringOf
import com.atelier_nyaarium.switchboard.vault.entryAnswerOp
import com.atelier_nyaarium.switchboard.vault.entryAnswerOutcome
import com.atelier_nyaarium.switchboard.vault.MatchPresenceProof
import com.atelier_nyaarium.switchboard.vault.consumeMatchPresenceProof
import com.atelier_nyaarium.switchboard.vault.matchingSecret
import com.atelier_nyaarium.switchboard.vault.refusedAnswerLine
import com.atelier_nyaarium.switchboard.vault.rememberOf
import com.atelier_nyaarium.switchboard.vault.rememberPlan
import com.atelier_nyaarium.switchboard.vault.rememberedName
import com.atelier_nyaarium.switchboard.vault.sealDraft
import com.atelier_nyaarium.switchboard.vault.secretChoices
import java.util.UUID
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
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
	private val provision: ProvisionFence,
	private val valueAnswer: (suspend (String, ConsoleOp) -> ConsoleClient.ValueAnswer)? = null,
	/** Re-reads that Gateway's policies. */
	private val policyWritten: (String) -> Unit = {},
	/** Off the main thread. */
	private val matching: CoroutineDispatcher = Dispatchers.Default,
	private val now: () -> Long,
	/** Monotonic; ages a presence proof. */
	private val elapsed: () -> Long,
) : ClearsOnReprovision {
	private val manager get() = collaborators.vault
	private val proofLock = Any()
	private var matchProof: MatchPresenceProof? = null

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
		sweepRequests()
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
		synchronized(proofLock) {
			matchProof = null
			manager.addRequest(team, request)
		}
	}

	fun onRetract(requestId: String) {
		synchronized(proofLock) {
			matchProof = null
			manager.settleRequest(requestId)
		}
	}

	fun sweepRequests(at: Long = now()): Boolean = synchronized(proofLock) {
		val changed = manager.sweepRequests(at)
		if (changed) matchProof = null
		changed
	}

	fun clearMatchProof() {
		synchronized(proofLock) { matchProof = null }
	}

	override suspend fun clearInMemory() = clearMatchProof()

	fun pendingRequest(requestId: String): VaultPendingRequest? = manager.request(requestId)

	suspend fun ownerPresent(activity: FragmentActivity?): Boolean = collaborators.gate.require(activity)

	/**
	 * Answers one request; a typed value seals under the request id, and a deny may carry a steering
	 * note. Runs on the repository's scope, so closing the card that asked cannot cut it short.
	 * Typing a value needs no presence.
	 */
	suspend fun answer(
		pending: VaultPendingRequest,
		decision: String,
		presence: suspend () -> Boolean,
		typedValue: String? = null,
		note: String? = null,
	): Boolean {
		clearMatchProof()
		if (decision != VAULT_DECISION_DENY && pending.entryId != null && !presence()) return false
		return repoScope.async { answerNow(pending, decision, typedValue, note) }.await()
	}

	/** Answering secrets match first. */
	private fun matchFor(typed: String, gatewayId: String, answering: List<VaultAnswering>?): String? {
		val candidates = secretChoices(views(), gatewayId, answering).mapNotNull { choice -> reveal(choice.entryId)?.let { choice.entryId to it } }
		return matchingSecret(typed, candidates)
	}

	/** "Every approval", lock on and passed. */
	private fun presenceCarries(): Boolean =
		state.value.biometricLock && AppLock.unlocked.value && collaborators.gate.matchPresenceBridgeEnabled()

	/** Presence precedes matching. */
	suspend fun saveTyped(pending: VaultPendingRequest, typed: String, presence: suspend () -> Boolean): TypedSave {
		clearMatchProof()
		val request = pending.request as? VaultRequest.Typed ?: return TypedSave.Declined
		// Owed before asked.
		val owed = presenceCarries()
		val lockEpoch = AppLock.epoch
		if (!presence()) return TypedSave.Declined
		if (!manager.listed) return TypedSave.Refused(VAULT_UNLISTED)
		val gatewayId = runIsolated { gatewayOf(pending.team) }.getOrNull() ?: return TypedSave.Refused(Line.VAULT_NO_GATEWAY.text)
		val revisions = views().associate { it.id to it.revision }
		val match = withContext(matching) { matchFor(typed, gatewayId, answeringOf(request)) }
		if (match != null) {
			synchronized(proofLock) {
				val revision = revisions[match]
				if (owed && revision != null && lockEpoch == AppLock.epoch && presenceCarries() && manager.request(pending.requestId) != null) {
					matchProof = MatchPresenceProof(pending.requestId, match, revision, lockEpoch, elapsed())
				}
			}
			return TypedSave.Matched(match)
		}
		return TypedSave.Form(NewSecretSeed(typed, gatewayId, newEntryId(), newPolicyId()))
	}

	/** Needs presence first. */
	suspend fun answerWithEntry(pending: VaultPendingRequest, op: ConsoleOp.VaultAnswerEntry, presence: suspend () -> Boolean): EntryAnswered {
		val reuse = synchronized(proofLock) {
			val decision = consumeMatchPresenceProof(
				matchProof,
				pending.requestId,
				op.entryId,
				manager.stored(op.entryId)?.clear?.revision,
				AppLock.epoch,
				elapsed(),
				appLockEngaged = state.value.biometricLock && !AppLock.unlocked.value,
			)
			matchProof = decision.remaining
			decision.reuse &&
				pending.requestId == op.requestId &&
				manager.request(pending.requestId) != null &&
				presenceCarries()
		}
		if (!reuse && !presence()) return EntryAnswered.Declined
		return repoScope.async { answerWithEntryNow(pending, op) }.await()
	}

	/** Save, then answer. */
	suspend fun saveAndAnswer(
		pending: VaultPendingRequest,
		draft: VaultDraft,
		seed: NewSecretSeed,
		presence: suspend () -> Boolean,
	): SavedAnswer {
		clearMatchProof()
		if (!presence()) return SavedAnswer.Declined
		return repoScope.async {
			val request = pending.request as? VaultRequest.Typed ?: return@async SavedAnswer.NotSaved(ENTRY_REFUSED)
			if (!manager.listed) return@async SavedAnswer.NotSaved(VAULT_UNLISTED)
			// Match the final value.
			withContext(matching) { matchFor(draft.value.orEmpty(), seed.gatewayId, answeringOf(request)) }
				?.let { return@async SavedAnswer.Matched(it) }
			val outcome = save(draft.copy(id = seed.entryId))
			if (outcome !is VaultSaveOutcome.Applied) return@async SavedAnswer.NotSaved(vaultSaveLine(outcome) ?: Line.VAULT_UNREACHABLE.text)
			val name = rememberedName(draft.privateTitle.ifBlank { draft.publicTitle })
			val plan = rememberPlan(request, SecretChoice(outcome.id, name)) { null }
			val op = entryAnswerOp(pending.requestId, outcome.id, VAULT_DECISION_ONCE, rememberOf(plan, seed.policyId))
				?: return@async SavedAnswer.Saved(outcome.id, EntryAnswered.Stays(ENTRY_REFUSED))
			SavedAnswer.Saved(outcome.id, answerWithEntryNow(pending, op))
		}.await()
	}

	private suspend fun answerWithEntryNow(pending: VaultPendingRequest, op: ConsoleOp.VaultAnswerEntry): EntryAnswered {
		val key = "vault:${pending.requestId}"
		fun stays(line: String) = EntryAnswered.Stays(line).also { report(vaultNoticeLine(pending, line), key) }
		val client = collaborators.client
		if (client == null && valueAnswer == null) return stays(Line.VAULT_NOT_CONNECTED.text)
		val began = provision.capture()
		val gatewayId = runIsolated { gatewayOf(pending.team) }.getOrNull() ?: return stays(Line.VAULT_NO_GATEWAY.text)
		val answer = runCatchingCancellable {
			valueAnswer?.invoke(gatewayId, op) ?: client?.sendValueAnswer(gatewayId, op) ?: ConsoleClient.ValueAnswer.Unreachable
		}.onFailure { DebugLog.log("Vault", "entry answer failed: ${it.message?.take(80)}") }.getOrNull()
			?: return stays(Line.VAULT_UNREACHABLE.text)
		val outcome = when (answer) {
			is ConsoleClient.ValueAnswer.Undelivered -> return stays(reasonSentence(Act.VAULT_ANSWER, answer.reason))
			ConsoleClient.ValueAnswer.Unreachable -> return stays(Line.VAULT_UNREACHABLE.text)
			is ConsoleClient.ValueAnswer.Refused -> return stays(reasonSentence(Act.VAULT_ANSWER, answer.reason))
			is ConsoleClient.ValueAnswer.Answered -> runIsolated {
				wireJson.decodeFromJsonElement<ConsoleVaultAnswerEntryResult>(answer.result)
			}.getOrNull()?.let(::entryAnswerOutcome) ?: return stays(Line.VAULT_UNREADABLE.text)
		}
		when (outcome) {
			is EntryAnswered.Answered -> {
				settleRequest(pending.requestId)
				state.update { it.withoutNoticeKey(key) }
				provision.land(began) { manager.recordAnswer(pending) }
				refreshGrantsNow(gatewayId)
				if (op.remember != null) policyWritten(gatewayId)
			}
			is EntryAnswered.Gone -> {
				settleRequest(pending.requestId)
				outcome.line?.let { report(it, key) } ?: state.update { it.withoutNoticeKey(key) }
			}
			is EntryAnswered.Stays -> report(vaultNoticeLine(pending, outcome.line), key)
			EntryAnswered.Declined -> Unit
		}
		return outcome
	}

	private suspend fun answerNow(
		pending: VaultPendingRequest,
		decision: String,
		typedValue: String?,
		note: String?,
	): Boolean {
		clearMatchProof()
		val key = "vault:${pending.requestId}"
		fun report(line: String) = this.report(vaultNoticeLine(pending, line), key)
		val client = collaborators.client
		if (client == null && valueAnswer == null) return false.also { report(Line.VAULT_NOT_CONNECTED.text) }
		val began = provision.capture()
		val value = typedValue?.let { text ->
			collaborators.sealing()?.seal(text, VAULT_TYPED_KIND, pending.requestId)
				?: return false.also { report(Line.VAULT_NO_KEY.text) }
		}
		val gatewayId = runIsolated { gatewayOf(pending.team) }.getOrNull()
			?: return false.also { report(Line.VAULT_NO_GATEWAY.text) }
		val op = ConsoleOp.VaultAnswer(
			requestId = pending.requestId,
			decision = decision,
			value = value,
			note = note?.trim()?.ifEmpty { null },
		)
		val answer = runCatchingCancellable {
			valueAnswer?.invoke(gatewayId, op) ?: client?.sendValueAnswer(gatewayId, op) ?: ConsoleClient.ValueAnswer.Unreachable
		}.onFailure { DebugLog.log("Vault", "answer failed: ${it.message?.take(80)}") }.getOrNull()
			?: return false.also { report(Line.VAULT_UNREACHABLE.text) }
		if (!answerDeliverySettled(answer)) {
			when (answer) {
				is ConsoleClient.ValueAnswer.Undelivered -> report(reasonSentence(Act.VAULT_ANSWER, answer.reason))
				ConsoleClient.ValueAnswer.Unreachable -> report(Line.VAULT_UNREACHABLE.text)
				else -> Unit
			}
			return false
		}
		settleRequest(pending.requestId)
		if (answer is ConsoleClient.ValueAnswer.Refused) {
			report(reasonSentence(Act.VAULT_ANSWER, answer.reason))
			return false
		}
		if (answer !is ConsoleClient.ValueAnswer.Answered) return false
		val result = runIsolated {
			wireJson.decodeFromJsonElement<ConsoleVaultAnswerResult>(answer.result)
		}.getOrNull() ?: return false.also { report(Line.VAULT_UNREADABLE.text) }
		if (result.ok) {
			state.update { it.withoutNoticeKey(key) }
			if (decision != VAULT_DECISION_DENY) provision.land(began) { manager.recordAnswer(pending) }
		} else {
			refusedAnswerLine(result.refusal, result.reason)?.let(::report) ?: state.update { it.withoutNoticeKey(key) }
		}
		if (result.ok && decision != VAULT_DECISION_DENY) refreshGrantsNow(gatewayId)
		return result.ok
	}

	private fun settleRequest(requestId: String) = synchronized(proofLock) {
		matchProof = null
		manager.settleRequest(requestId)
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

	private fun report(message: String, key: String? = null) {
		state.update { it.withNotice(message, key) }
	}

	private fun newOpId(): String = UUID.randomUUID().toString()

	private fun newEntryId(): String = UUID.randomUUID().toString().replace("-", "").take(32)

	/** As the policy editor mints one. */
	fun newPolicyId(): String = PolicyDraft.fresh().id

	private companion object {
		val REFRESH_RETRY_DELAYS_MS = listOf(5_000L, 30_000L)
	}
}
