package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.isComposite
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget
import com.atelier_nyaarium.switchboard.proto.parseSessionName

////////////////////////////////
//  Interfaces & Types

/** What a container header draws. */
internal data class ContainerButtons(
	val start: Boolean,
	val stop: Boolean,
	val create: Boolean,
	/** Start or Stop pending. */
	val busy: Boolean,
	val building: Boolean,
)

/** Stop's question: the active sessions, by label. */
internal data class StopAsk(val target: String, val names: List<String>)

////////////////////////////////
//  Functions & Helpers

/** Nothing to press for an unreachable Gateway or a newer state word. */
internal fun containerButtons(container: SpawnContainer, reachable: Boolean, inFlight: Boolean): ContainerButtons {
	val run = container.run.takeIf { reachable }
	return ContainerButtons(
		start = run == ContainerRun.STOPPED,
		// A start still building is ended by Stop.
		stop = run == ContainerRun.STARTING || run == ContainerRun.RUNNING,
		create = reachable && spawnReadiness(container, container.harnesses).enabled,
		busy = inFlight,
		building = run == ContainerRun.STARTING,
	)
}

/** What a session says while it waits on its container; null when it waits on none. */
internal fun containerStartLine(word: SessionWord?, container: ContainerRun?): String? =
	"Starting container".takeIf {
		(word == SessionWord.WAKING || word == SessionWord.VERIFYING) &&
			container != null && container != ContainerRun.RUNNING
	}

/** The container a spawn point is, or a session lives in; null for a host shell. */
internal fun containerAt(state: ChatState, target: String): SpawnContainer? {
	val point = when (val parsed = runIsolated { parseQualifiedTarget(target) }.getOrNull()) {
		is SpawnPoint -> parsed
		is Address -> parsed.spawnPoint
		null -> return null
	}
	return state.gateways.container(point.gateway, point.spawn)
}

/** One Gateway's sessions inside a container project. */
internal fun sessionsIn(sessions: List<Team>, gatewayId: String, project: String): List<Team> =
	sessions.filter {
		it.gatewayId == gatewayId && it.kind != "devcontainer" && isComposite(it.shortName) &&
			parseSessionName(it.shortName).project == project
	}

/** Anything but idle: a turn, a compaction, an approval or limit wait, a delegated agent or workflow step. */
internal fun isActive(presence: Presence): Boolean =
	presence.isLive && (
		presence.working == true ||
			presence.compacting == true ||
			presence.promptId != null ||
			presence.limitBlocked == true ||
			presence.teammates == true ||
			presence.workflow == true
		)

/** What Stop asks before it acts; null means it acts at once. */
internal fun stopAsk(target: String, sessionsInContainer: List<Team>, label: (String) -> String): StopAsk? =
	sessionsInContainer
		.filter { isActive(it.presence) }
		.map { label(it.name) }
		.takeIf { it.isNotEmpty() }
		?.let { StopAsk(target, it) }
