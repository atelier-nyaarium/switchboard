package com.atelier_nyaarium.switchboard.runbooks

import com.atelier_nyaarium.switchboard.ChatState
import com.atelier_nyaarium.switchboard.SpawnHarnesses
import com.atelier_nyaarium.switchboard.SpawnReadiness
import com.atelier_nyaarium.switchboard.localSessions
import com.atelier_nyaarium.switchboard.proto.SpawnPoint
import com.atelier_nyaarium.switchboard.proto.parseQualifiedTarget
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.spawnChoices

/** `address` is what the fire sends, always qualified; `label` is what the sheet shows. */
internal data class FireTarget(
	val address: String,
	val label: String,
	val readiness: SpawnReadiness = SpawnReadiness.READY,
)

internal fun spawnTargets(state: ChatState, gatewayId: String): List<FireTarget> {
	val domainId = state.domainId ?: return emptyList()
	return spawnChoices(state, gatewayId)
		.mapNotNull { choice ->
			runIsolated { SpawnPoint.of(domainId, gatewayId, choice.spawn).canonical }
				.getOrNull()
				?.let { FireTarget(it, choice.label, choice.readiness) }
		}
		.distinctBy { it.address }
}

/** The CLIs a new-session target's spawn point runs; none for what names no spawn point. */
internal fun availableAt(state: ChatState, gatewayId: String, address: String): SpawnHarnesses {
	val point = runIsolated { parseQualifiedTarget(address) }.getOrNull() as? SpawnPoint
		?: return SpawnHarnesses.Known(emptySet())
	return state.gateways.harnessesOn(gatewayId, point.spawn)
}

internal fun sessionTargets(state: ChatState, gatewayId: String): List<FireTarget> =
	localSessions(state.sessions(), state.domainId.orEmpty())
		.filter { it.gatewayId == gatewayId && it.kind != "devcontainer" }
		.map { FireTarget(it.name, state.label(it.name)) }
		.sortedBy { it.label }
