package com.atelier_nyaarium.switchboard

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext

internal enum class RequestKind { APPLY, KNOWLEDGE, FILE, WINDOWS }

/** What a request is about, so a second tap on the same one sends nothing. */
internal data class RequestKey(val address: String, val kind: RequestKind, val subject: String)

internal enum class RequestState { SENDING, SENT, FAILED }

internal sealed interface Submitted {
	data object Sent : Submitted

	data object AlreadySending : Submitted

	data object Failed : Submitted
}

/**
 * The one road for a message the phone composes for a session. It claims the request before sending, so
 * two taps or two screens send it once, and publishes each request's state for the screens to draw.
 */
internal class SessionRequests(private val host: WorkspaceHost) : ClearsOnReprovision {
	private val held = MutableStateFlow<Map<RequestKey, RequestState>>(emptyMap())

	val states: StateFlow<Map<RequestKey, RequestState>> = held

	suspend fun submit(key: RequestKey, text: String): Submitted {
		val generation = host.generation.capture()
		while (true) {
			val all = held.value
			if (all[key] == RequestState.SENDING) return Submitted.AlreadySending
			if (held.compareAndSet(all, all + (key to RequestState.SENDING))) break
		}
		if (!host.generation.isCurrent(generation)) {
			held.update { if (it[key] == RequestState.SENDING) it - key else it }
			return Submitted.Failed
		}
		// Outlives the screen that asked.
		val sent = withContext(NonCancellable) {
			try {
				host.send(key.address, text)
			} catch (e: Exception) {
				DebugLog.log("Requests", "send failed: ${e.message}")
				false
			}
		}
		if (host.generation.isCurrent(generation)) {
			held.update { it + (key to if (sent) RequestState.SENT else RequestState.FAILED) }
		}
		return if (sent) Submitted.Sent else Submitted.Failed
	}

	override suspend fun clearInMemory() {
		held.value = emptyMap()
	}
}
