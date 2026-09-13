package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import com.atelier_nyaarium.switchboard.proto.VaultHolder
import com.atelier_nyaarium.switchboard.proto.composeSessionName
import com.atelier_nyaarium.switchboard.vault.VaultPendingRequest
import com.atelier_nyaarium.switchboard.vault.holder

/** Root or session data scope. */
internal sealed interface ViewScope {
	data object Everything : ViewScope

	data class Session(val team: String) : ViewScope
}

internal fun ViewScope.groupsOf(entries: List<GatewayEntry>): List<GatewayEntry> = when (this) {
	ViewScope.Everything -> entries
	is ViewScope.Session -> entries.filter { it.id == gatewayId() }
}

internal fun ViewScope.newOn(registry: GatewayRegistry): List<String> = when (this) {
	ViewScope.Everything -> registry.reachableIds()
	is ViewScope.Session -> registry.reachableIds().filter { it == gatewayId() }
}.sorted()

internal fun ViewScope.routinesOf(rows: List<RoutineState>): List<RoutineState> = when (this) {
	ViewScope.Everything -> rows
	is ViewScope.Session -> addressOf(team)?.let { address -> rows.filter { it.routine.target.spawn == address.spawn } }.orEmpty()
}

internal fun ViewScope.requestsOf(pending: List<VaultPendingRequest>): List<VaultPendingRequest> = when (this) {
	ViewScope.Everything -> pending
	is ViewScope.Session -> pending.filter { it.team == team }
}

/** Grants grouped by Gateway. */
internal fun ViewScope.grantsOf(grants: Map<String, List<VaultGrant>>): List<Pair<String, VaultGrant>> = when (this) {
	ViewScope.Everything -> grants.entries.flatMap { (gatewayId, list) -> list.map { gatewayId to it } }
	is ViewScope.Session -> {
		val gatewayId = gatewayId()
		if (gatewayId == null) emptyList() else grantsHeldBy(grants, team).map { gatewayId to it }
	}
}

/** Grant holders use local session names. */
internal fun grantsHeldBy(grants: Map<String, List<VaultGrant>>, team: String): List<VaultGrant> {
	val address = addressOf(team) ?: return emptyList()
	val local = composeSessionName(address.spawn, address.session)
	return grants[address.gateway].orEmpty().filter { (it.holder as? VaultHolder.Session)?.sessionTarget == local }
}

private fun ViewScope.Session.gatewayId(): String? = addressOf(team)?.gateway
