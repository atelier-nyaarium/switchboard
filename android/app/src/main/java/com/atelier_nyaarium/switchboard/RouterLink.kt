package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

////////////////////////////////
//  Interfaces & Types

/** Why a round trip got no answer. */
enum class Miss { NO_NETWORK, UNREACHABLE, INTERRUPTED, SERVER_FAULT }

/** Stands until the Router verifies a signed call. */
enum class Refusal { CERT_CHANGED, TOKEN_REJECTED, OUT_OF_DATE, NOT_SET_UP, NOT_ADMITTED, CLOCK_SKEW }

/** What a Router door, or setup, witnessed. */
internal sealed interface RouterEvent {
	/** The Router responded. */
	data object Reached : RouterEvent

	/** The Router verified a signed call. */
	data object Accepted : RouterEvent

	data class Refused(val why: Refusal) : RouterEvent

	data class Missed(val why: Miss) : RouterEvent

	/** Setup starts over. */
	data object SetupOwed : RouterEvent

	/** Still owed; this device's cause. */
	data class SetupStalled(val cause: String) : RouterEvent

	data object SetupSettled : RouterEvent

	/** Waits on the owner. */
	data class SetupRefused(val cause: String) : RouterEvent
}

sealed interface Setup {
	/** Tried again each pass. */
	data class Owed(val stall: String? = null) : Setup

	data object Settled : Setup

	data class Refused(val cause: String) : Setup
}

/** Misses this long apart read as down. */
internal const val DOWN_AFTER_MS = 5_000L

/** This device's standing with the Router. Only [Writer] folds one. */
@ConsistentCopyVisibility
data class RouterLink private constructor(
	val reached: Boolean,
	/** First miss since an answer. */
	val missedAt: Long?,
	val down: Boolean,
	val miss: Miss?,
	val refusal: Refusal?,
	val setup: Setup,
) {
	val settled: Boolean get() = setup == Setup.Settled

	private fun after(event: RouterEvent, at: Long): RouterLink = when (event) {
		RouterEvent.Reached -> answered()
		RouterEvent.Accepted -> answered().copy(refusal = null)
		is RouterEvent.Refused -> answered().copy(refusal = event.why)
		is RouterEvent.Missed -> {
			val since = missedAt ?: at
			copy(missedAt = since, down = down || at - since >= DOWN_AFTER_MS, miss = event.why)
		}
		RouterEvent.SetupOwed -> none
		is RouterEvent.SetupStalled -> copy(setup = Setup.Owed(event.cause))
		RouterEvent.SetupSettled -> copy(setup = Setup.Settled)
		is RouterEvent.SetupRefused -> copy(setup = Setup.Refused(event.cause))
	}

	private fun answered() = copy(reached = true, missedAt = null, down = false, miss = null)

	/** The one fold, held by the repository. */
	internal class Writer(private val state: MutableStateFlow<ChatState>, private val now: () -> Long) {
		fun note(event: RouterEvent) {
			state.update { s -> s.router.after(event, now()).let { if (it == s.router) s else s.copy(router = it) } }
		}
	}

	companion object {
		val none = RouterLink(reached = false, missedAt = null, down = false, miss = null, refusal = null, setup = Setup.Owed())
	}
}

////////////////////////////////
//  Functions & Helpers

/** A dropped handshake carries no validation evidence and is not a changed certificate. */
internal fun certValidationEvidence(e: Throwable): Boolean {
	var t: Throwable? = e
	var hops = 0
	while (t != null && hops < 8) {
		if (t is java.security.cert.CertificateException) return true
		if (t is java.security.cert.CertPathValidatorException) return true
		val msg = t.message ?: ""
		if (msg.contains("trust anchor", ignoreCase = true) || msg.contains("CertPath", ignoreCase = true)) return true
		t = t.cause
		hops++
	}
	return false
}

/** A round trip that threw, read by the exception's type. */
internal fun eventOfFailure(e: Throwable): RouterEvent = when {
	certValidationEvidence(e) -> RouterEvent.Refused(Refusal.CERT_CHANGED)
	e is java.net.UnknownHostException -> RouterEvent.Missed(Miss.NO_NETWORK)
	e is javax.net.ssl.SSLException -> RouterEvent.Missed(Miss.INTERRUPTED)
	else -> RouterEvent.Missed(Miss.UNREACHABLE)
}

/** A status from the console surface. A 400 there is the op's own refusal. */
internal fun eventOfStatus(code: Int): RouterEvent = when (code) {
	401, 403 -> RouterEvent.Refused(Refusal.TOKEN_REJECTED)
	404, 405, 501 -> RouterEvent.Refused(Refusal.NOT_SET_UP)
	in 500..599 -> RouterEvent.Missed(Miss.SERVER_FAULT)
	else -> RouterEvent.Reached
}

/** An owner op's status: a 400 is an op this Router cannot parse. */
internal fun eventOfOwnerOpStatus(code: Int): RouterEvent =
	if (code == 400) RouterEvent.Refused(Refusal.OUT_OF_DATE) else eventOfStatus(code)

/** A refusal reason that speaks of this device. */
internal fun refusalOfReason(reason: String?): Refusal? = when (reason) {
	Protocol.Wire.OP_REASON_NOT_ADMITTED -> Refusal.NOT_ADMITTED
	Protocol.Wire.OP_REASON_CLOCK_SKEW -> Refusal.CLOCK_SKEW
	else -> null
}

/** What an answered owner op says of this device. Any other refusal came after the admission check. */
internal fun eventOfOwnerAnswer(answer: JsonElement): RouterEvent {
	val body = answer as? JsonObject ?: return RouterEvent.Accepted
	if ((body["outcome"] as? JsonPrimitive)?.content != Protocol.Wire.OP_OUTCOME_REFUSED) return RouterEvent.Accepted
	return refusalOfReason((body["reason"] as? JsonPrimitive)?.content)?.let(RouterEvent::Refused) ?: RouterEvent.Accepted
}

/** A socket's refused frame. Only a welcome verifies the hello. */
internal fun eventOfSocketRefusal(reason: String?): RouterEvent =
	refusalOfReason(reason)?.let(RouterEvent::Refused) ?: RouterEvent.Reached
