package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.policies.PolicyDraft
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyPutResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** Gateway calls, as a port. */
internal interface PolicyGateway {
	suspend fun list(gatewayId: String): ListAnswer<AuthorizationPolicy>

	suspend fun put(gatewayId: String, policy: AuthorizationPolicy, baseRevision: Long?): ConsolePolicyPutResult

	suspend fun delete(gatewayId: String, policyId: String, baseRevision: Long): ConsolePolicyDeleteResult

	suspend fun enable(gatewayId: String, policyId: String, enabled: Boolean, baseRevision: Long): ConsolePolicyPutResult
}

internal interface PolicyHost {
	val gateway: PolicyGateway?
}

/** A gateway answer, never a Boolean. */
internal sealed interface PolicySaved {
	data class Stored(val policy: AuthorizationPolicy) : PolicySaved
	data class Refused(val reason: String, val heldRevision: Long) : PolicySaved
	data object Unreachable : PolicySaved
}

internal sealed interface PolicyDeleted {
	data object Deleted : PolicyDeleted
	data class Refused(val reason: String) : PolicyDeleted
	data object Unreachable : PolicyDeleted
}

/** Nothing held on the phone; a change re-reads. */
internal class PolicyOps(
	private val state: MutableStateFlow<ChatState>,
	private val host: PolicyHost,
) : ClearsOnReprovision {
	val edits = EditorSessions<EditKey, PolicyDraft, SaveSaid>(
		unattended = { left -> tell(leftLine(left.draft.name, "Policy", left.said?.reason.orEmpty())) },
	)

	private fun tell(message: String) = state.update { it.copy(transientMessages = it.transientMessages + message) }

	private val reads = GatewayReadFence()

	/** One counter per row, keyed by gateway and id. */
	private val toggles = GatewayReadFence()

	val toggleRefusals = androidx.compose.runtime.mutableStateOf<Map<Pair<String, String>, String>>(emptyMap())

	override suspend fun clearInMemory() {
		reads.clear()
		toggles.clear()
		edits.clear()
		toggleRefusals.value = emptyMap()
	}

	suspend fun commit(key: EditKey, opening: Long) = edits.send(key, opening) { draft ->
		val candidate = draft.toPolicy() ?: return@send EditOutcome.Stays(SaveSaid("Not a complete policy"))
		when (val saved = save(candidate, draft.revision.takeIf { it > 0L }, key.gatewayId)) {
			is PolicySaved.Stored -> EditOutcome.Done
			is PolicySaved.Refused -> EditOutcome.Stays(SaveSaid(saved.reason, saved.heldRevision))
			PolicySaved.Unreachable -> EditOutcome.Stays(SaveSaid(GATEWAY_UNREACHABLE))
		}
	}

	suspend fun remove(key: EditKey, opening: Long) = edits.send(key, opening) { draft ->
		when (val deleted = delete(draft.id, draft.revision, key.gatewayId)) {
			PolicyDeleted.Deleted -> EditOutcome.Done
			is PolicyDeleted.Refused -> EditOutcome.Stays(SaveSaid(deleted.reason))
			PolicyDeleted.Unreachable -> EditOutcome.Stays(SaveSaid(GATEWAY_UNREACHABLE))
		}
	}

	fun toggleRefusalFor(gatewayId: String, policyId: String): String? = toggleRefusals.value[gatewayId to policyId]

	/** All roster Gateways, concurrently. */
	suspend fun refreshAll() {
		refreshEach(state.value.gateways.ids(), ::refresh)
	}

	suspend fun refresh(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val answer = reads.list(TAG, gatewayId) { client.list(gatewayId) }
		state.update { held -> held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(policies = it.policies.after(answer)) }) }
	}

	/** The gateway names the stored revision. */
	suspend fun save(policy: AuthorizationPolicy, baseRevision: Long?, gatewayId: String): PolicySaved {
		val client = host.gateway ?: return PolicySaved.Unreachable
		if (gatewayId.isBlank()) return PolicySaved.Unreachable
		val answer = attempt { client.put(gatewayId, policy, baseRevision) } ?: return PolicySaved.Unreachable
		refresh(gatewayId)
		return saved(answer)
	}

	/** The gateway's own answer. */
	suspend fun delete(policyId: String, baseRevision: Long, gatewayId: String): PolicyDeleted {
		val client = host.gateway ?: return PolicyDeleted.Unreachable
		if (gatewayId.isBlank()) return PolicyDeleted.Unreachable
		val answer = attempt { client.delete(gatewayId, policyId, baseRevision) } ?: return PolicyDeleted.Unreachable
		refresh(gatewayId)
		return if (answer.deleted) PolicyDeleted.Deleted else PolicyDeleted.Refused(answer.reason ?: "This Gateway kept it")
	}

	/** The answer reaches the row; an older toggle's answer never overwrites a newer one's. */
	suspend fun setEnabled(policyId: String, enabled: Boolean, baseRevision: Long, gatewayId: String): PolicySaved {
		val key = gatewayId to policyId
		val client = host.gateway
		if (client == null || gatewayId.isBlank()) {
			noteToggle(key, GATEWAY_UNREACHABLE)
			return PolicySaved.Unreachable
		}
		var saved: PolicySaved = PolicySaved.Unreachable
		val current = toggles.read("$gatewayId/$policyId") {
			val answer = attempt { client.enable(gatewayId, policyId, enabled, baseRevision) }
			refresh(gatewayId)
			saved = if (answer == null) PolicySaved.Unreachable else saved(answer)
			saved
		}
		if (current is GatewayRead.Fresh) {
			noteToggle(
				key,
				when (val landed = saved) {
					is PolicySaved.Stored -> null
					is PolicySaved.Refused -> landed.reason
					PolicySaved.Unreachable -> GATEWAY_UNREACHABLE
				},
			)
		}
		return saved
	}

	private fun saved(answer: ConsolePolicyPutResult): PolicySaved {
		val stored = answer.policy
		if (!answer.stored || stored == null) {
			return PolicySaved.Refused(answer.reason ?: "This Gateway holds a different copy", answer.revision)
		}
		return PolicySaved.Stored(stored)
	}

	private fun noteToggle(key: Pair<String, String>, reason: String?) {
		toggleRefusals.value = if (reason == null) toggleRefusals.value - key else toggleRefusals.value + (key to reason)
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = gatewayAttempt(TAG, call)

	private companion object {
		const val TAG = "Policy"
	}
}
