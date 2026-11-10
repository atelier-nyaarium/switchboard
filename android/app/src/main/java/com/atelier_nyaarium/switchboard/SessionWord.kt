package com.atelier_nyaarium.switchboard

/** A session's status, most urgent first. */
enum class SessionWord(val text: String) {
	NEEDS_APPROVAL("needs approval"),
	LIMIT_HIT("limit hit"),
	LOGIN("login"),
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

	/** Waits on the owner. A red chip. */
	val blocked: Boolean get() =
		this == NEEDS_APPROVAL || this == LIMIT_HIT || this == LOGIN || this == CHECK_TERMINAL
}

/** [working] and [needsLogin] as `ChatState` folds them. */
internal fun sessionWord(presence: Presence, working: Boolean, needsLogin: Boolean, now: Long): SessionWord {
	val word = when {
		presence.isOnline -> when {
			presence.promptId != null -> SessionWord.NEEDS_APPROVAL
			presence.limitBlocked == true -> SessionWord.LIMIT_HIT
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
	// A logged-out CLI never finishes verifying.
	return if (needsLogin && !word.blocked && word != SessionWord.ENDED) SessionWord.LOGIN else word
}

internal fun ChatState.sessionWord(team: String, presence: Presence, now: Long): SessionWord =
	sessionWord(presence, working(team), needsLogin(team), now)
