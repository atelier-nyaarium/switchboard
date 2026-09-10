package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.LOCAL_DOMAIN_SENTINEL
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.TeamInfo
import com.atelier_nyaarium.switchboard.proto.composeSessionName
import com.atelier_nyaarium.switchboard.proto.parseSessionName
import com.atelier_nyaarium.switchboard.proto.parseTarget

////////////////////////////////
//  Interfaces & Types

/** UI model for the sessions board. Mapped from the wire TeamInfo in `teams()`, and also
 * constructed locally for ended threads whose team has left the bridge (a state that never
 * exists on the wire). `name` is the canonical address key (`domain.gateway.spawn.session`, or
 * `domain.gateway.spawn` for a spawn-point); `shortName` and `gatewayId` derive from it. */
data class Team(
	val name: String,
	// Everything a Gateway reports about this session, and what that report is WORTH. Deliberately
	// one value rather than the loose fields it used to be: a bare `status`/`working`/`needsLogin`
	// says nothing about whether it arrived on the pushed presence plane (current) or the 30-second
	// See Presence.kt for the whole reasoning; the status string in there has no accessor on purpose.
	val presence: Presence,
	val kind: String = "loose",
	// Domain/Gateway identify rows.
	val domainId: String? = null,
	val sessionLabel: String? = null,
	// Null for local rows.
	val presenceFresh: String? = null,
) {
	/** Short local field shown in the UI: `spawn` or `spawn.session` from the canonical address. */
	val shortName: String get() = localFieldOf(name)

	/** Owning Gateway id (the gateway segment of the canonical address). */
	val gatewayId: String get() = gatewayOf(name)

	/** A live socket serves this session. Forwarded rather than reached through `presence` because
	 * it is the single most-read question on the board; everything else goes through [presence] so
	 * the answer arrives with the authority that qualifies it. */
	val isLive: Boolean get() = presence.isLive
}

////////////////////////////////
//  Functions & Helpers

/** The local team field (`spawn` or `spawn.session`) of a canonical address string, for the UI's
 * short labels and the board's spawn-point nesting. A SpawnPoint (arity 3) yields its bare spawn; an
 * Address (arity 4) yields `spawn.session`. */
internal fun localFieldOf(canonical: String): String =
	when (val t = parseTarget(canonical, "", "")) {
		is Address -> composeSessionName(t.spawn, t.session)
		is SpawnPoint -> t.spawn
	}

/** [localFieldOf] for a value that may ALREADY be a local field rather than a canonical address.
 * `parseTarget` throws on one, and the board holds both forms: its entries store the local field
 * while a chat's `Team.name` is the address. Idempotent, which is what lets a caller apply it
 * without first knowing which form it was handed. */
internal fun localFieldOrSelf(value: String): String = runCatching { localFieldOf(value) }.getOrDefault(value)

/** The Gateway segment of a canonical address string. */
internal fun gatewayOf(canonical: String): String =
	when (val t = parseTarget(canonical, "", "")) {
		is Address -> t.gateway
		is SpawnPoint -> t.gateway
	}

/** Re-stamp what this row's report is worth. [teamInfoToTeam] stamps POLLED because it serves both
 * delivery channels and cannot tell them apart; only the caller holding the answer knows more. */
internal fun Team.withAuthority(a: Authority): Team = copy(presence = presence.withAuthority(a))

/** Attach this device's own outstanding request for this session, or clear it. */
internal fun Team.withReceipt(r: ActionReceipt?): Team = copy(presence = presence.withReceipt(r))

/**
 * The (gateway, project) a spawn target names, for remembering what a Gateway was last spawned on.
 *
 * A BARE target is a project on the home Gateway - that is what bare means everywhere else in this
 * app - so an empty gateway segment resolves to this device's own rather than to nothing. Reading it
 * as nothing is not a small miss: `CreateDialogTarget.targetFor` returns bare for the local Gateway,
 * which is the common case, so it silently disabled remembering entirely for the machine most likely
 * to be spawned on.
 *
 * Null for a target that does not parse, and for a full session address, which names a session
 * rather than a spawn point and is not something the create dialog produces.
 */
internal fun spawnTargetKey(target: String, homeGatewayId: String): Pair<String, String>? {
	if (homeGatewayId.isEmpty()) return null
	// Parsed WITH the local context, not blank context. `parseTarget` throws on a bare local field
	// when it has no Domain and Gateway to qualify it against - which is the whole reason
	// `localFieldOrSelf` exists - so parsing blank silently rejected every bare target, meaning every
	// yet"; only the gateway and spawn are read back out.
	val parsed = runCatching { parseTarget(target, LOCAL_DOMAIN_SENTINEL, homeGatewayId) }.getOrNull() ?: return null
	// A SpawnPoint is what the create dialog builds. An Address names a SESSION, and a project whose
	// own name contains a dot parses as one (arity decides, and nothing here knows the catalog), so
	// such a project is simply not remembered. That degrades to no suggestion, never a wrong one.
	if (parsed !is SpawnPoint || parsed.gateway.isEmpty() || parsed.spawn.isEmpty()) return null
	return parsed.gateway to parsed.spawn
}

/** Merge a fresh presence answer over the prior rows, keeping prior rows the answer does not speak
 * for. Fresh wins on a name collision. Pure, so the two merge policies (plane push, refresh with
 * coverage) share one rule and stay testable. */
internal fun mergePresence(prior: List<Team>, fresh: List<Team>, keepPrior: (Team) -> Boolean): List<Team> {
	val freshNames = fresh.mapTo(HashSet()) { it.name }
	return fresh + prior.filter { it.name !in freshNames && keepPrior(it) }
}

/** Keep linked-domain rows. */
internal fun keepPriorRow(row: Team, planeDomain: String): Boolean =
	row.domainId != null && row.domainId != planeDomain

internal fun teamInfoToTeam(it: TeamInfo, homeGatewayId: String): Team {
	val gatewayId = it.gatewayId.ifEmpty { homeGatewayId }
	// Matches gateway address minting.
	val parsed = parseSessionName(it.team)
	val canonicalName = if (it.kind == "devcontainer") {
		SpawnPoint.of(it.domainId, gatewayId, parsed.project).canonical
	} else {
		Address.of(it.domainId, gatewayId, parsed.project, parsed.session).canonical
	}
	return Team(
		name = canonicalName,
		// Caller reapplies channel freshness.
		presence = Presence.reported(
			status = it.status,
			authority = Authority.POLLED,
			mode = it.mode ?: "",
			queueDepth = it.queue_depth.toInt(),
			version = it.version,
			working = it.working,
			needsLogin = it.needsLogin,
			limitBlocked = it.limitBlocked,
			limitDetail = it.limitDetail,
		),
		kind = it.kind,
		domainId = it.domainId,
		sessionLabel = it.sessionLabel,
		presenceFresh = it.presenceFresh,
	)
}
