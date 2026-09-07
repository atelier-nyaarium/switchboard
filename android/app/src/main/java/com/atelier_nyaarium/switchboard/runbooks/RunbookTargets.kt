package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.GatewayGroupKey
import com.atelier_nyaarium.switchboard.HOST_SPAWN_IDS
import com.atelier_nyaarium.switchboard.hostSpawnChoices
import com.atelier_nyaarium.switchboard.hostSpawnLabel
import com.atelier_nyaarium.switchboard.localSessions

internal data class FireTarget(val address: String, val label: String)

internal fun spawnTargets(state: ChatState): List<FireTarget> {
	val domainId = state.domainId.orEmpty()
	val key = GatewayGroupKey(domainId, state.homeGatewayId)
	val hosts = hostSpawnChoices(state.gatewaySpawnPoints, key, domainId)
	val containers = localSessions(state.sessions(), domainId)
		.filter { it.kind == "devcontainer" }
		.map { it.shortName }
		.filterNot { it in HOST_SPAWN_IDS }
	return (hosts.map { FireTarget(it, hostSpawnLabel(it, hosts)) } + containers.map { FireTarget(it, it) })
		.distinctBy { it.address }
}

internal fun sessionTargets(state: ChatState): List<FireTarget> =
	localSessions(state.sessions(), state.domainId.orEmpty())
		.filterNot { it.kind == "devcontainer" }
		.map { FireTarget(it.shortName, state.label(it.name)) }
		.sortedBy { it.label }
