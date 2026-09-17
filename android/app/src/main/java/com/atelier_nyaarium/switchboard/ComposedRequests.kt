package com.atelier_nyaarium.switchboard

import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
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

	/** The send threw, so it may still have landed. Never a refusal. */
	data object Unknown : Submitted
}

/**
 * Taken when a caller's work begins. One older than the road's ledger is refused; one that claimed before
 * the road was cleared has its message in flight, and only its landing is refused.
 */
internal class RequestAdmission internal constructor(
	internal val generation: Long,
	/** Names one hold, so a replacement is never mistaken for what it replaced. */
	val incarnation: Long,
)

/**
 * What a caller wrote before its send, so a reply that beats the send's answer already finds it. The road
 * says when the write comes back out, and the hold puts back whatever it replaced.
 */
internal fun interface RequestHold {
	fun withdraw()
}

/** The states and the generation they were written under, so one CAS decides admission and the claim. */
private data class Ledger(val generation: Long, val states: Map<RequestKey, RequestState>) :
	Map<RequestKey, RequestState> by states {
	fun holding(key: RequestKey, state: RequestState) = copy(states = states + (key to state))
}

/**
 * The one road for a message the phone composes for a session. Admission and the claim are decided
 * together, so two taps or two screens send it once, and each request's state is published for the screens.
 */
internal class ComposedRequests(private val host: WorkspaceHost) : ClearsOnReprovision {
	private val held = MutableStateFlow(Ledger(host.generation.capture(), emptyMap()))

	private val incarnations = AtomicLong(0)

	val states: StateFlow<Map<RequestKey, RequestState>> = held

	fun admit(): RequestAdmission = RequestAdmission(host.generation.capture(), incarnations.incrementAndGet())

	suspend fun submit(
		key: RequestKey,
		text: String,
		admission: RequestAdmission = admit(),
		hold: RequestHold? = null,
	): Submitted =
		// Outlives the screen that asked, landing included: a cancelled caller discards what this returns.
		withContext(NonCancellable) {
			val submitted = claimKey(key, admission) ?: sendOnce(key, text, admission)
			when (submitted) {
				Submitted.Sent, Submitted.Unknown -> {}
				Submitted.Failed, Submitted.AlreadySending -> hold?.withdraw()
			}
			submitted
		}

	/** A new ledger, so a claim or a landing read against the old one cannot commit. */
	override suspend fun clearInMemory() {
		held.value = Ledger(host.generation.capture(), emptyMap())
	}

	/** Null once the key is claimed, so nothing draws as sending that never goes. */
	private fun claimKey(key: RequestKey, admission: RequestAdmission): Submitted? {
		while (true) {
			val all = held.value
			if (all.generation != admission.generation) return Submitted.Failed
			if (all[key] == RequestState.SENDING) return Submitted.AlreadySending
			if (held.compareAndSet(all, all.holding(key, RequestState.SENDING))) return null
		}
	}

	private suspend fun sendOnce(key: RequestKey, text: String, admission: RequestAdmission): Submitted {
		// Null is a throw, which is neither a send nor a refusal.
		var sent: Boolean? = null
		try {
			sent = host.send(key.address, text)
		} catch (e: CancellationException) {
			throw e
		} catch (e: Exception) {
			DebugLog.log("Requests", "send failed: ${e.message}")
		} finally {
			// Settled however the send ended.
			val landed = if (sent == true) RequestState.SENT else RequestState.FAILED
			held.update { if (it.generation == admission.generation) it.holding(key, landed) else it }
		}
		return when (sent) {
			true -> Submitted.Sent
			false -> Submitted.Failed
			null -> Submitted.Unknown
		}
	}
}
