package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.HOST_SPAWN_IDS
import com.atelier_nyaarium.switchboard.hostSpawnChoices
import com.atelier_nyaarium.switchboard.hostSpawnLabel
import com.atelier_nyaarium.switchboard.localSessions
import com.atelier_nyaarium.switchboard.proto.SpawnPoint

/** `address` is what the fire sends, always qualified; `label` is what the sheet shows. */
internal data class FireTarget(val address: String, val label: String)

private fun teamsOn(state: ChatState, gatewayId: String) =
	localSessions(state.sessions(), state.domainId.orEmpty()).filter { it.gatewayId == gatewayId }

internal fun spawnTargets(state: ChatState, gatewayId: String): List<FireTarget> {
	val domainId = state.domainId ?: return emptyList()
	val hosts = hostSpawnChoices(state.gateways.hostSpawns(gatewayId))
	val containers = teamsOn(state, gatewayId)
		.filter { it.kind == "devcontainer" }
		.map { it.shortName }
		.filterNot { it in HOST_SPAWN_IDS }
	return (hosts.map { it to hostSpawnLabel(it, hosts) } + containers.map { it to it })
		.mapNotNull { (spawn, label) ->
			runCatching { SpawnPoint.of(domainId, gatewayId, spawn).canonical }.getOrNull()?.let { FireTarget(it, label) }
		}
		.distinctBy { it.address }
}

internal fun sessionTargets(state: ChatState, gatewayId: String): List<FireTarget> =
	teamsOn(state, gatewayId)
		.filterNot { it.kind == "devcontainer" }
		.map { FireTarget(it.name, state.label(it.name)) }
		.sortedBy { it.label }
