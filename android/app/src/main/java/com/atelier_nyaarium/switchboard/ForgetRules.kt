package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Address
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget

////////////////////////////////
//  Interfaces & Types

/** What a forget asks before it runs. */
internal sealed interface ForgetAsk {
	data object None : ForgetAsk

	/** [container] is the spawn point a Start takes. */
	data class ContainerStopped(val container: String) : ForgetAsk

	data object GatewayOffline : ForgetAsk
}

/** A forget waiting on its answer. */
internal data class ForgetAsking(val team: String, val cancelTasks: Boolean?, val ask: ForgetAsk)

/** How a container start asked for by a held forget ended. */
internal sealed interface ContainerSettle {
	data object Running : ContainerSettle

	data class Failed(val line: String) : ContainerSettle
}

////////////////////////////////
//  Constants

internal const val FORGET_ANYWAY = "Forget anyway"
internal const val FORGET_START_CONTAINER = "Start container"
internal const val CONTAINER_STOPPED_TITLE = "Container is stopped"
internal const val CONTAINER_STOPPED_LINE =
	"Switchboard can only purge this session's data while its container is up. " +
		"Forget anyway purges it the next time the container starts."
internal const val GATEWAY_OFFLINE_TITLE = "Gateway is offline"
internal const val GATEWAY_OFFLINE_LINE =
	"Switchboard can only purge this session's data while its Gateway is online. " +
		"Forget anyway purges it the next time the Gateway connects."
internal const val CONTAINER_START_FAILED = "The container did not start."

////////////////////////////////
//  Functions & Helpers

/** Offline needs a current roster that says so; a cached one asks nothing. */
internal fun forgetAsk(state: ChatState, team: String): ForgetAsk {
	val address = runIsolated { parseQualifiedTarget(team) }.getOrNull() as? Address ?: return ForgetAsk.None
	val roster = state.gateways
	if (roster.current && roster.connected(address.gateway) == false) return ForgetAsk.GatewayOffline
	val container = roster.container(address.gateway, address.spawn) ?: return ForgetAsk.None
	if (container.run != ContainerRun.STOPPED) return ForgetAsk.None
	return ForgetAsk.ContainerStopped(address.spawnPoint.canonical)
}

internal fun forgetAskTitle(ask: ForgetAsk): String =
	if (ask is ForgetAsk.ContainerStopped) CONTAINER_STOPPED_TITLE else GATEWAY_OFFLINE_TITLE

internal fun forgetAskLine(ask: ForgetAsk): String =
	if (ask is ForgetAsk.ContainerStopped) CONTAINER_STOPPED_LINE else GATEWAY_OFFLINE_LINE

/**
 * Null while the start is still out. [before] is the container when Start was pressed, so a state
 * that has not moved is judged only once its op is no longer in flight.
 */
internal fun containerSettle(before: SpawnContainer?, now: SpawnContainer?, inFlight: Boolean): ContainerSettle? = when {
	now?.run == ContainerRun.RUNNING -> ContainerSettle.Running
	now == before -> if (inFlight) null else ContainerSettle.Failed(now?.failure ?: CONTAINER_START_FAILED)
	now?.run == ContainerRun.STARTING -> null
	else -> ContainerSettle.Failed(now?.failure ?: CONTAINER_START_FAILED)
}
