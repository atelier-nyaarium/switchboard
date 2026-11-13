package com.atelier_nyaarium.switchboard

////////////////////////////////
//  Interfaces & Types

/** What every surface draws of the Router link. */
internal sealed interface LinkView {
	data object Online : LinkView

	/** Setup has not finished. */
	data class Connecting(val cause: String?) : LinkView

	data class Reconnecting(val cause: String?) : LinkView

	data class Offline(val cause: String?) : LinkView

	data class NoGateway(val awaitingHost: Boolean) : LinkView

	/** Waits on the owner. */
	data class Refused(val cause: String) : LinkView
}

internal enum class LinkTone { GOOD, CALM, WARN, BAD }

////////////////////////////////
//  Functions & Helpers

/** The one reading of the link. */
internal fun linkView(state: ChatState): LinkView {
	val link = state.router
	(link.setup as? Setup.Refused)?.let { return LinkView.Refused(it.cause) }
	// Admission is one of the owed steps.
	link.refusal?.takeUnless { it == Refusal.NOT_ADMITTED && !link.settled }?.let { return LinkView.Refused(refusalLine(it)) }
	val cause = link.miss?.let(::missLine) ?: (link.setup as? Setup.Owed)?.stall
	if (link.down) return LinkView.Offline(cause)
	if (!link.settled) return LinkView.Connecting(cause)
	if (state.gateways.current && state.gateways.gateways.isEmpty()) return LinkView.NoGateway(state.firstRooted)
	if (link.missedAt != null) return LinkView.Reconnecting(cause)
	return LinkView.Online
}

internal fun missLine(miss: Miss): String = when (miss) {
	Miss.NO_NETWORK -> "Offline - no network"
	Miss.UNREACHABLE -> "Can't reach the server - retrying"
	Miss.INTERRUPTED -> "Secure connection interrupted - retrying"
	Miss.SERVER_FAULT -> "Server error - retrying"
}

internal fun refusalLine(refusal: Refusal): String = when (refusal) {
	Refusal.CERT_CHANGED -> "Server certificate changed - re-run setup.sh"
	Refusal.TOKEN_REJECTED -> "Sign-in rejected - re-run setup.sh and re-import the setup blob"
	Refusal.OUT_OF_DATE -> "App is out of date - update the app, or re-run setup.sh"
	Refusal.NOT_SET_UP -> "Server not set up - run setup.sh on the server"
	Refusal.NOT_ADMITTED -> "Not enrolled - re-run setup.sh and re-import the setup blob"
	Refusal.CLOCK_SKEW -> "Your device clock is off - sync the time"
}

/** A thrown call, worded for a notice. */
internal fun failureLine(e: Throwable): String {
	val event = when (e) {
		is RouterStatus -> eventOfOwnerOpStatus(e.code)
		is java.io.IOException -> eventOfFailure(e)
		is SecureStorageUnavailable, is IdentityCorrupt -> return localCause(e)
		else -> null
	}
	return when (event) {
		is RouterEvent.Refused -> refusalLine(event.why)
		is RouterEvent.Missed -> missLine(event.why)
		else -> "Error: ${e.message?.take(100) ?: e.javaClass.simpleName}"
	}
}

/** The status notification's line. */
internal fun statusLine(view: LinkView): String = when (view) {
	LinkView.Online -> "Bridge online"
	is LinkView.Connecting -> "Connecting..."
	is LinkView.Reconnecting -> "Reconnecting..."
	is LinkView.Offline -> "Offline"
	is LinkView.NoGateway -> "Enrolled"
	is LinkView.Refused -> "Can't connect"
}

/** The sessions header's dot and label. */
internal fun headerLine(view: LinkView): Pair<LinkTone, String> = when (view) {
	LinkView.Online -> LinkTone.GOOD to "Bridge online"
	is LinkView.NoGateway -> LinkTone.CALM to "Enrolled"
	is LinkView.Connecting -> LinkTone.WARN to (view.cause ?: "Connecting...")
	is LinkView.Reconnecting -> LinkTone.WARN to (view.cause ?: "Reconnecting...")
	is LinkView.Offline -> LinkTone.BAD to (view.cause ?: "Offline")
	is LinkView.Refused -> LinkTone.BAD to view.cause
}

/** A conversation's banner. A wake hides a passing cause. */
internal fun threadBanner(notice: String?, view: LinkView, waking: Boolean): String? = notice ?: when (view) {
	is LinkView.Refused -> view.cause
	is LinkView.Offline -> view.cause.takeUnless { waking }
	else -> null
}

/** The Router unreached before setup settled, so no home record was read. */
internal fun routerUnreachable(state: ChatState): Boolean = !state.router.settled && when (val view = linkView(state)) {
	is LinkView.Offline, is LinkView.Refused -> true
	is LinkView.Connecting -> view.cause != null
	else -> false
}
