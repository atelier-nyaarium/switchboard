package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.GatewayGroupKey
import com.atelier_nyaarium.switchboard.HOST_SPAWN_IDS
import com.atelier_nyaarium.switchboard.hostSpawnChoices
import com.atelier_nyaarium.switchboard.hostSpawnLabel
import com.atelier_nyaarium.switchboard.localSessions

internal data class FireTarget(val address: String, val label: String)

private fun teamsOn(state: ChatState, gatewayId: String) =
	localSessions(state.sessions(), state.domainId.orEmpty()).filter { it.gatewayId == gatewayId }

internal fun spawnTargets(state: ChatState, gatewayId: String): List<FireTarget> {
	val domainId = state.domainId.orEmpty()
	val key = GatewayGroupKey(domainId, gatewayId)
	val hosts = hostSpawnChoices(state.gatewaySpawnPoints, key)
	val containers = teamsOn(state, gatewayId)
		.filter { it.kind == "devcontainer" }
		.map { it.shortName }
		.filterNot { it in HOST_SPAWN_IDS }
	return (hosts.map { FireTarget(it, hostSpawnLabel(it, hosts)) } + containers.map { FireTarget(it, it) })
		.distinctBy { it.address }
}

internal fun sessionTargets(state: ChatState, gatewayId: String): List<FireTarget> =
	teamsOn(state, gatewayId)
		.filterNot { it.kind == "devcontainer" }
		.map { FireTarget(it.shortName, state.label(it.name)) }
		.sortedBy { it.label }
