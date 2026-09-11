package com.atelier_nyaarium.switchboard

/**
 * Pure helpers for the cross-Domain-presence UI: a linked friend's sessions, as the Router's
 * projection carries them (see PresenceOps.applyCrossDomainPresence). Android-free, so a JVM unit
 * test pins the freshness rule.
 */

////////////////////////////////
//  Interfaces & Types

/** How recently a Domain's entry was refreshed (`lastRefreshedAt`). Judged on the phone against a
 * threshold, never shipped as a boolean on the wire. */
enum class CrossDomainFreshness {
	/** Refreshed within the threshold - shown as the friend's live state. */
	FRESH,

	/** Refreshed once, but not recently enough to trust as current. */
	STALE,

	/** Nothing has landed for this Domain yet (linked, but no push/pull has arrived this session). */
	UNKNOWN,
}

////////////////////////////////
//  Functions & Helpers

/** Well above the Router projection's cadence, so ordinary timing never flashes a stale chip. */
const val CROSS_DOMAIN_STALE_THRESHOLD_MS = 5 * 60_000L

/** FRESH if `lastRefreshedAt` is within `staleThresholdMs` of `now`; STALE if older; UNKNOWN if there
 * is nothing to judge (no entry has landed for this Domain yet). */
fun crossDomainFreshness(
	lastRefreshedAt: Long?,
	now: Long,
	staleThresholdMs: Long = CROSS_DOMAIN_STALE_THRESHOLD_MS,
): CrossDomainFreshness =
	when {
		lastRefreshedAt == null -> CrossDomainFreshness.UNKNOWN
		now - lastRefreshedAt <= staleThresholdMs -> CrossDomainFreshness.FRESH
		else -> CrossDomainFreshness.STALE
	}
