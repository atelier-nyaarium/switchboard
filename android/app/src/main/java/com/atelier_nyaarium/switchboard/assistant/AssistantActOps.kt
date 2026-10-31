package com.atelier_nyaarium.switchboard.assistant

import androidx.fragment.app.FragmentActivity
import com.atelier_nyaarium.switchboard.ClearsOnReprovision
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.runCatchingCancellable
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.proto.AssistantActRequest
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

interface AssistantActStore {
	fun loadAssistantActs(): String?
	fun saveAssistantActs(json: String)
}

@Serializable
internal data class PendingAssistantAct(
	val gatewayId: String,
	val team: String,
	val request: AssistantActRequest,
)

@Serializable
private data class AssistantActBlob(val requests: List<PendingAssistantAct> = emptyList())

internal sealed interface AssistantActAnswer {
	data object Answered : AssistantActAnswer
	data class Refused(val reason: String) : AssistantActAnswer
	data object Unreachable : AssistantActAnswer
	data object Expired : AssistantActAnswer
	data object NeedsOwner : AssistantActAnswer
}

internal class AssistantActManager(private val store: AssistantActStore) : ClearsOnReprovision {
	private val json = Json { ignoreUnknownKeys = true }
	private val lock = Any()
	@Volatile private var blob = load()
	private val _pending = MutableStateFlow(blob.requests.filter { it.request.deadlineAt > System.currentTimeMillis() })
	val pending: StateFlow<List<PendingAssistantAct>> = _pending

	private fun load(): AssistantActBlob {
		val raw = store.loadAssistantActs() ?: return AssistantActBlob()
		return runIsolated { json.decodeFromString<AssistantActBlob>(raw) }.getOrDefault(AssistantActBlob())
	}

	private fun persist(requests: List<PendingAssistantAct>): Boolean {
		val next = AssistantActBlob(requests)
		if (next == blob) return true
		val saved = runIsolated { store.saveAssistantActs(json.encodeToString(AssistantActBlob.serializer(), next)) }
		if (saved.isFailure) {
			DebugLog.log("AssistantAct", "stored requests could not be written")
			return false
		}
		blob = next
		_pending.value = requests.filter { it.request.deadlineAt > System.currentTimeMillis() }
		return true
	}

	fun onRequest(gatewayId: String, team: String, request: AssistantActRequest, now: Long = System.currentTimeMillis()): Boolean = synchronized(lock) {
		if (gatewayId.isBlank() || team.isBlank() || request.deadlineAt <= now) return@synchronized false
		val live = blob.requests.filter { it.request.deadlineAt > now }
		if (live.any { it.gatewayId == gatewayId && it.request.requestId == request.requestId }) return@synchronized false
		persist(live + PendingAssistantAct(gatewayId, team, request))
	}

	fun request(gatewayId: String, requestId: String): PendingAssistantAct? =
		pending.value.firstOrNull { it.gatewayId == gatewayId && it.request.requestId == requestId }

	fun settleRequest(gatewayId: String, requestId: String) = synchronized(lock) {
		persist(blob.requests.filterNot { it.gatewayId == gatewayId && it.request.requestId == requestId })
	}

	fun sweepRequests(now: Long = System.currentTimeMillis()): Boolean = synchronized(lock) {
		val kept = blob.requests.filter { it.request.deadlineAt > now }
		if (kept.size == blob.requests.size) return@synchronized false
		persist(kept)
	}

	fun forgetTeam(team: String) = synchronized(lock) {
		persist(blob.requests.filterNot { it.team == team })
	}

	fun clearRequests() = synchronized(lock) { persist(emptyList()) }

	override suspend fun clearInMemory() {
		synchronized(lock) {
			blob = AssistantActBlob()
			_pending.value = emptyList()
			runIsolated { store.saveAssistantActs(json.encodeToString(AssistantActBlob.serializer(), blob)) }
				.onFailure { DebugLog.log("AssistantAct", "stored requests could not be cleared") }
		}
	}
}

internal class AssistantActOps(
	private val manager: AssistantActManager,
	private val ownerPresent: suspend (FragmentActivity?) -> Boolean,
	private val send: suspend (String, ConsoleOp.AssistantActAnswer, String) -> JsonObject?,
) {
	val pending: StateFlow<List<PendingAssistantAct>> get() = manager.pending

	fun onRequest(gatewayId: String, team: String, request: AssistantActRequest) =
		manager.onRequest(gatewayId, team, request)

	fun onRetract(gatewayId: String, requestId: String) = manager.settleRequest(gatewayId, requestId)

	fun request(gatewayId: String, requestId: String): PendingAssistantAct? = manager.request(gatewayId, requestId)

	fun sweepRequests(now: Long = System.currentTimeMillis()) = manager.sweepRequests(now)

	fun forgetTeam(team: String) = manager.forgetTeam(team)

	fun clearRequests() = manager.clearRequests()

	fun isExpired(pending: PendingAssistantAct, now: Long = System.currentTimeMillis()): Boolean =
		pending.request.deadlineAt <= now

	suspend fun answer(
		pending: PendingAssistantAct,
		decision: String,
		note: String? = null,
		activity: FragmentActivity? = null,
	): AssistantActAnswer {
		val current = manager.request(pending.gatewayId, pending.request.requestId) ?: return AssistantActAnswer.Expired
		if (current != pending || isExpired(pending)) {
			manager.sweepRequests()
			return AssistantActAnswer.Expired
		}
		if (decision !in setOf("approve", "deny")) return AssistantActAnswer.Refused("Invalid answer")
		if (decision == "approve" && !runCatchingCancellable { ownerPresent(activity) }.getOrDefault(false)) {
			return AssistantActAnswer.NeedsOwner
		}
		if (manager.request(pending.gatewayId, pending.request.requestId) != pending || isExpired(pending)) {
			manager.sweepRequests()
			return AssistantActAnswer.Expired
		}
		val op = ConsoleOp.AssistantActAnswer(
			requestId = pending.request.requestId,
			decision = decision,
			note = note?.trim()?.take(2_048)?.ifEmpty { null }.takeIf { decision == "deny" },
		)
		val result = runCatchingCancellable { send(pending.gatewayId, op, pending.request.requestId) }
			.onFailure { DebugLog.log("AssistantAct", "answer could not be sent") }
			.getOrNull() ?: return AssistantActAnswer.Unreachable
		manager.settleRequest(pending.gatewayId, pending.request.requestId)
		val accepted = result["ok"]?.jsonPrimitive?.booleanOrNull ?: false
		if (accepted) return AssistantActAnswer.Answered
		val reason = result["reason"]?.jsonPrimitive?.content ?: "The answer was refused"
		return AssistantActAnswer.Refused(reason)
	}
}
