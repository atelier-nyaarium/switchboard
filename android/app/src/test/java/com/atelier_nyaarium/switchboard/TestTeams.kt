package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.TeamInfo

/**
 * A Team for tests, so the presence shape has ONE construction site across the suite rather than a
 * hand-rolled `Team(...)` per file. Defaults to a LIVE row: most suites are about labels, ordering
 * or tombstones and care only that a row exists, while the suites that are about freshness say so.
 */
internal fun testTeam(
	name: String,
	status: String = Presence.ONLINE,
	authority: Authority = Authority.LIVE,
	mode: String = "",
	queueDepth: Int = 0,
	version: String? = null,
	working: Boolean? = null,
	needsLogin: Boolean? = null,
	limitBlocked: Boolean? = null,
	limitDetail: String? = null,
	promptId: String? = null,
	workflow: Boolean? = null,
	teammates: Boolean? = null,
	kind: String = "loose",
	sessionLabel: String? = null,
): Team = Team(
	name = name,
	presence = Presence.reported(
		TeamInfo(
			team = name,
			gatewayId = "gw",
			domainId = "dom",
			status = status,
			mode = mode,
			kind = kind,
			queue_depth = queueDepth.toLong(),
			version = version,
			working = working,
			needsLogin = needsLogin,
			limitBlocked = limitBlocked,
			limitDetail = limitDetail,
			promptId = promptId,
			workflow = workflow,
			teammates = teammates,
		),
		authority,
	),
	kind = kind,
	sessionLabel = sessionLabel,
)
