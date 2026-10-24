package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.ClearsOnReprovision
import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.ConsoleClient
import com.atelier_nyaarium.switchboard.DebugLog
import com.atelier_nyaarium.switchboard.runCatchingCancellable
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.proto.AssistantSendRequest
import com.atelier_nyaarium.switchboard.proto.ConsoleAssistantSendAnswerResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

interface AssistantSendStore {
	fun loadAssistantSends(): String?

	fun saveAssistantSends(json: String)
}

@Serializable
internal data class PendingAssistantSend(
	val gatewayId: String,
	val team: String,
	val request: AssistantSendRequest,
)

@Serializable
private data class AssistantSendBlob(val requests: List<PendingAssistantSend> = emptyList())

internal sealed interface AssistantSendAnswer {
	data object Answered : AssistantSendAnswer
	data class Refused(val reason: String) : AssistantSendAnswer
	data object Unreachable : AssistantSendAnswer
	data object Expired : AssistantSendAnswer
}

/** Pending approvals per Gateway. */
internal class AssistantSendManager(private val store: AssistantSendStore) : ClearsOnReprovision {
	private val json = Json { ignoreUnknownKeys = true }
	private val lock = Any()
	@Volatile private var blob = load()
	private val _pending = MutableStateFlow(blob.requests.filter { it.request.deadlineAt > System.currentTimeMillis() })

	val pending: StateFlow<List<PendingAssistantSend>> = _pending

	init {
		sweepRequests()
	}

	private fun load(): AssistantSendBlob {
		val raw = store.loadAssistantSends() ?: return AssistantSendBlob()
		return runIsolated { json.decodeFromString<AssistantSendBlob>(raw) }.getOrElse {
			DebugLog.log("AssistantSend", "stored requests could not be decoded")
			AssistantSendBlob()
		}
	}

	private fun persist(requests: List<PendingAssistantSend>): Boolean {
		val next = AssistantSendBlob(requests)
		if (next == blob) return true
		val saved = runIsolated { store.saveAssistantSends(json.encodeToString(AssistantSendBlob.serializer(), next)) }
		if (saved.isFailure) {
			DebugLog.log("AssistantSend", "stored requests could not be written")
			return false
		}
		blob = next
		_pending.value = requests.filter { it.request.deadlineAt > System.currentTimeMillis() }
		return true
	}

	fun onRequest(gatewayId: String, team: String, request: AssistantSendRequest, now: Long = System.currentTimeMillis()): Boolean {
		synchronized(lock) {
			if (request.deadlineAt <= now) return false
			val live = blob.requests.filter { it.request.deadlineAt > now }
			if (live.any { it.gatewayId == gatewayId && it.request.requestId == request.requestId }) return false
			return persist(live + PendingAssistantSend(gatewayId, team, request))
		}
	}

	fun request(gatewayId: String, requestId: String): PendingAssistantSend? =
		pending.value.firstOrNull { it.gatewayId == gatewayId && it.request.requestId == requestId }

	fun settleRequest(gatewayId: String, requestId: String) {
		synchronized(lock) {
			persist(blob.requests.filterNot { it.gatewayId == gatewayId && it.request.requestId == requestId })
		}
	}

	fun sweepRequests(now: Long = System.currentTimeMillis()): Boolean = synchronized(lock) {
		val kept = blob.requests.filter { it.request.deadlineAt > now }
		if (kept.size == blob.requests.size) return false
		persist(kept)
	}

	fun forgetTeam(team: String) {
		synchronized(lock) {
			persist(blob.requests.filterNot { it.team == team })
		}
	}

	fun clearRequests() {
		synchronized(lock) { persist(emptyList()) }
	}

	/** Clears even if the save fails. */
	override suspend fun clearInMemory() {
		synchronized(lock) {
			blob = AssistantSendBlob()
			_pending.value = emptyList()
			runIsolated { store.saveAssistantSends(json.encodeToString(AssistantSendBlob.serializer(), blob)) }
				.onFailure { DebugLog.log("AssistantSend", "stored requests could not be cleared") }
		}
	}
}

/** Answers at source Gateway. */
internal class AssistantSendOps(
	private val state: MutableStateFlow<ChatState>,
	private val manager: AssistantSendManager,
	private val client: () -> ConsoleClient?,
) {
	val pending: StateFlow<List<PendingAssistantSend>> get() = manager.pending

	fun onRequest(gatewayId: String, team: String, request: AssistantSendRequest) {
		manager.onRequest(gatewayId, team, request)
	}

	fun onRetract(gatewayId: String, requestId: String) = manager.settleRequest(gatewayId, requestId)

	fun request(gatewayId: String, requestId: String): PendingAssistantSend? = manager.request(gatewayId, requestId)

	fun sweepRequests(now: Long = System.currentTimeMillis()): Boolean = manager.sweepRequests(now)

	fun forgetTeam(team: String) = manager.forgetTeam(team)

	fun clearRequests() = manager.clearRequests()

	suspend fun answer(pending: PendingAssistantSend, decision: String, note: String? = null): AssistantSendAnswer {
		if (manager.request(pending.gatewayId, pending.request.requestId) == null) return AssistantSendAnswer.Expired
		if (pending.request.deadlineAt <= System.currentTimeMillis()) {
			manager.sweepRequests()
			return AssistantSendAnswer.Expired
		}
		val console = client() ?: return AssistantSendAnswer.Unreachable
		val result = runCatchingCancellable {
			console.valueResult<ConsoleAssistantSendAnswerResult>(
				console.sendValueOp(
					pending.gatewayId,
					ConsoleOp.AssistantSendAnswer(
						requestId = pending.request.requestId,
						decision = decision,
						note = note?.trim()?.ifEmpty { null },
					),
				),
				"assistant_send_answer",
			)
		}.onFailure { DebugLog.log("AssistantSend", "answer failed: ${it.message?.take(80)}") }.getOrNull()
			?: return AssistantSendAnswer.Unreachable
		manager.settleRequest(pending.gatewayId, pending.request.requestId)
		if (result.ok) return AssistantSendAnswer.Answered
		val reason = result.reason ?: "The answer was refused"
		state.update { it.copy(error = "Assistant: $reason") }
		return AssistantSendAnswer.Refused(reason)
	}
}
