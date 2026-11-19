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

	private fun tell(message: String) = state.update { it.withNotice(message) }

	private val reads = GatewayReadFence()

	val toggles = ToggleFence()

	override suspend fun clearInMemory() {
		reads.clear()
		toggles.clear()
		edits.clear()
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

	/** All roster Gateways, concurrently. */
	suspend fun refreshAll() {
		refreshEach(state.value.gateways.ids(), ::refresh)
	}

	suspend fun refresh(gatewayId: String) {
		if (gatewayId.isBlank()) return
		val client = host.gateway
		val answer = reads.list(TAG, gatewayId, client?.let { held -> suspend { held.list(gatewayId) } }) ?: return
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

	suspend fun setEnabled(policyId: String, enabled: Boolean, baseRevision: Long, gatewayId: String): PolicySaved {
		val client = host.gateway
		if (client == null || gatewayId.isBlank()) {
			toggles.note(gatewayId, policyId, GATEWAY_UNREACHABLE)
			return PolicySaved.Unreachable
		}
		return toggles.run(gatewayId, policyId, ::toggleLine) {
			val answer = attempt { client.enable(gatewayId, policyId, enabled, baseRevision) }
			refresh(gatewayId)
			if (answer == null) PolicySaved.Unreachable else saved(answer)
		}
	}

	private fun toggleLine(saved: PolicySaved): String? = when (saved) {
		is PolicySaved.Stored -> null
		is PolicySaved.Refused -> saved.reason
		PolicySaved.Unreachable -> GATEWAY_UNREACHABLE
	}

	private fun saved(answer: ConsolePolicyPutResult): PolicySaved {
		val stored = answer.policy
		if (!answer.stored || stored == null) {
			return PolicySaved.Refused(answer.reason ?: "This Gateway holds a different copy", answer.revision)
		}
		return PolicySaved.Stored(stored)
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = gatewayAttempt(TAG, call)

	private companion object {
		const val TAG = "Policy"
	}
}
