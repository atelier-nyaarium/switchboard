package com.atelier_nyaarium.switchboard.vault

internal const val MATCH_PRESENCE_WINDOW_MS = 60_000L

/** Presence passed for one match. */
internal data class MatchPresenceProof(
	val requestId: String,
	val entryId: String,
	val revision: Long,
	val lockEpoch: Int,
	/** Monotonic, never wall time. */
	val givenAt: Long,
)

internal data class MatchPresenceDecision(val reuse: Boolean, val remaining: MatchPresenceProof?)

/** Any read spends the proof. `revision` is the held entry's; null when it is gone. */
internal fun consumeMatchPresenceProof(
	proof: MatchPresenceProof?,
	requestId: String,
	entryId: String,
	revision: Long?,
	lockEpoch: Int,
	now: Long,
	appLockEngaged: Boolean = false,
): MatchPresenceDecision {
	val reuse = proof != null &&
		proof.requestId == requestId &&
		proof.entryId == entryId &&
		proof.revision == revision &&
		proof.lockEpoch == lockEpoch &&
		now >= proof.givenAt &&
		now - proof.givenAt <= MATCH_PRESENCE_WINDOW_MS &&
		!appLockEngaged
	return MatchPresenceDecision(reuse, null)
}
