package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.policies.PolicyDraft
import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsolePolicyPutResult
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** Gateway calls, as a port. */
internal interface PolicyGateway {
	suspend fun list(gatewayId: String): PolicyListAnswer

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
) {
	private val drafts = java.util.concurrent.ConcurrentHashMap<Pair<String, String>, PolicyDraft>()

	private val reads = GatewayReadFence()

	/** One counter per row, keyed by gateway and id. */
	private val toggles = GatewayReadFence()

	val toggleRefusals = androidx.compose.runtime.mutableStateOf<Map<Pair<String, String>, String>>(emptyMap())

	fun draftFor(gatewayId: String, key: String): PolicyDraft? = drafts[gatewayId to key]

	fun keepDraft(gatewayId: String, key: String, draft: PolicyDraft) {
		drafts[gatewayId to key] = draft
	}

	fun dropDraft(gatewayId: String, key: String) {
		drafts.remove(gatewayId to key)
	}

	fun toggleRefusalFor(gatewayId: String, policyId: String): String? = toggleRefusals.value[gatewayId to policyId]

	/** All roster Gateways, concurrently. */
	suspend fun refreshAll() {
		coroutineScope { state.value.gateways.ids().map { id -> async { refresh(id) } }.awaitAll() }
	}

	/** Refused hides; unreachable keeps what was drawn. */
	suspend fun refresh(gatewayId: String) {
		val client = host.gateway ?: return
		if (gatewayId.isBlank()) return
		val read = reads.read(gatewayId) { attempt { client.list(gatewayId) } ?: PolicyListAnswer.Unreachable }
		if (read !is GatewayRead.Fresh) return
		when (val answer = read.value) {
			is PolicyListAnswer.Listed -> show(gatewayId, answer.policies)
			PolicyListAnswer.Refused -> hide(gatewayId)
			PolicyListAnswer.Unreachable -> {}
		}
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

	/** Gateway answer, replaced whole. */
	private fun show(gatewayId: String, policies: List<AuthorizationPolicy>) {
		state.update { held -> held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(policies = policies) }) }
	}

	private fun hide(gatewayId: String) {
		state.update { held -> held.copy(gateways = held.gateways.withEntry(gatewayId) { it.copy(policies = null) }) }
	}

	private suspend fun <T> attempt(call: suspend () -> T): T? = try {
		call()
	} catch (e: CancellationException) {
		throw e
	} catch (e: Exception) {
		DebugLog.log("Policy", "gateway call failed: ${e.message}")
		null
	}
}
