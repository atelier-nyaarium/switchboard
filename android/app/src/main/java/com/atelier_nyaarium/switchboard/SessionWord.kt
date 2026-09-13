package com.atelier_nyaarium.switchboard

/** A session's status, most urgent first. */
enum class SessionWord(val text: String) {
	LIMIT_HIT("limit hit"),
	CHECK_TERMINAL("check terminal"),
	WORKING("working..."),
	LIVE("live"),
	VERIFYING("verifying"),
	WAKING("waking..."),
	AVAILABLE("available"),
	ENDED("ended"),
	;

	/** Pulses on a card. */
	val busy: Boolean get() = this == WORKING || this == VERIFYING
}

/** [working] and [needsLogin] as `ChatState` folds them. */
internal fun sessionWord(presence: Presence, working: Boolean, needsLogin: Boolean, now: Long): SessionWord =
	when {
		presence.isOnline -> when {
			presence.limitBlocked == true -> SessionWord.LIMIT_HIT
			needsLogin -> SessionWord.CHECK_TERMINAL
			working -> SessionWord.WORKING
			else -> SessionWord.LIVE
		}
		presence.isVerifying -> SessionWord.VERIFYING
		presence.waking(now) -> SessionWord.WAKING
		// A send waiting on the wake.
		!presence.hasEnded && working -> SessionWord.WAKING
		presence.isAvailable -> SessionWord.AVAILABLE
		else -> SessionWord.ENDED
	}

internal fun ChatState.sessionWord(team: String, presence: Presence, now: Long): SessionWord =
	sessionWord(presence, working(team), needsLogin(team), now)
