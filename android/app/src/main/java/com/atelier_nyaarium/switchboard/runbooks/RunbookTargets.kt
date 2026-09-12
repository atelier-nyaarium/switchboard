package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.HOST_SPAWN_IDS
import com.atelier_nyaarium.switchboard.hostSpawnChoices
import com.atelier_nyaarium.switchboard.hostSpawnLabel
import com.atelier_nyaarium.switchboard.localSessions
import com.atelier_nyaarium.switchboard.proto.SpawnPoint

/** `address` is what the fire sends, always qualified; `label` is what the sheet shows. */
internal data class FireTarget(val address: String, val label: String)

/** `spawn` is the bare segment a routine stores; `label` is what a menu shows. */
internal data class SpawnChoice(val spawn: String, val label: String, val offered: Boolean = true)

private fun teamsOn(state: ChatState, gatewayId: String) =
	localSessions(state.sessions(), state.domainId.orEmpty()).filter { it.gatewayId == gatewayId }

/** Host spawns first, then this Gateway's devcontainers. */
internal fun spawnChoices(state: ChatState, gatewayId: String): List<SpawnChoice> {
	val hosts = hostSpawnChoices(state.gateways.hostSpawns(gatewayId))
	val containers = teamsOn(state, gatewayId)
		.filter { it.kind == "devcontainer" }
		.map { it.shortName }
		.filterNot { it in HOST_SPAWN_IDS }
	return (hosts.map { SpawnChoice(it, hostSpawnLabel(it, hosts)) } + containers.map { SpawnChoice(it, it) })
		.distinctBy { it.spawn }
}

/** A held spawn the Gateway no longer offers stays pickable, first and marked. */
internal fun spawnMenu(choices: List<SpawnChoice>, held: String): List<SpawnChoice> =
	if (held.isBlank() || choices.any { it.spawn == held }) choices
	else listOf(SpawnChoice(held, held, offered = false)) + choices

internal fun spawnTargets(state: ChatState, gatewayId: String): List<FireTarget> {
	val domainId = state.domainId ?: return emptyList()
	return spawnChoices(state, gatewayId)
		.mapNotNull { choice ->
			runCatching { SpawnPoint.of(domainId, gatewayId, choice.spawn).canonical }
				.getOrNull()
				?.let { FireTarget(it, choice.label) }
		}
		.distinctBy { it.address }
}

internal fun sessionTargets(state: ChatState, gatewayId: String): List<FireTarget> =
	teamsOn(state, gatewayId)
		.filterNot { it.kind == "devcontainer" }
		.map { FireTarget(it.name, state.label(it.name)) }
		.sortedBy { it.label }
