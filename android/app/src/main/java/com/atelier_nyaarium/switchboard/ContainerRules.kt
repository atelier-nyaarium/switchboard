package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.isComposite
import com.atelier_nyaarium.switchboard.proto.parseSessionName

////////////////////////////////
//  Interfaces & Types

/** What a container header draws. */
internal data class ContainerButtons(
	val start: Boolean,
	val stop: Boolean,
	val create: Boolean,
	/** A Start or Stop awaits its answer. */
	val busy: Boolean,
	val building: Boolean,
)

/** Stop's question: the active sessions, by label. */
internal data class StopAsk(val target: String, val names: List<String>)

////////////////////////////////
//  Functions & Helpers

/** Create only while running and some CLI can launch; nothing for an unreachable Gateway or a newer state word. */
internal fun containerButtons(container: SpawnContainer, reachable: Boolean, inFlight: Boolean): ContainerButtons {
	val run = container.run.takeIf { reachable }
	return ContainerButtons(
		start = run == ContainerRun.STOPPED,
		// A start still building is ended by Stop.
		stop = run == ContainerRun.STARTING || run == ContainerRun.RUNNING,
		create = run == ContainerRun.RUNNING && harnessesOf(container.harnesses).isNotEmpty(),
		busy = inFlight,
		building = run == ContainerRun.STARTING,
	)
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
