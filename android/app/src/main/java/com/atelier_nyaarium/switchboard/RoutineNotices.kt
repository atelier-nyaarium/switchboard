package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.RoutineState

/** A routine notification in the shade. */
internal data class ShadeRoutine(val id: Int, val gatewayId: String?)

internal data class RoutineNotice(
	val id: Int,
	val gatewayId: String,
	val row: RoutineState,
	val title: String,
	val text: String,
)

internal data class RoutineNoticePlan(val cancel: Set<Int>, val post: List<RoutineNotice>)

/**
 * The shade against what each Gateway last listed. A Gateway that has not answered says nothing, so
 * its notifications stay; one that answered, or left the roster, takes the ones its list no longer names.
 */
internal fun routineNoticePlan(
	registry: GatewayRegistry,
	shade: List<ShadeRoutine>,
	idOf: (String, String) -> Int,
	missText: (String) -> String,
): RoutineNoticePlan {
	val listed = registry.gateways.filter { it.routines.listed }
	val answered = listed.mapTo(HashSet()) { it.id }
	val everyListed = registry.current && listed.isNotEmpty() && listed.size == registry.gateways.size
	val rows = listed.flatMap { entry -> entry.routines.rows.map { entry.id to it } }
	val notices = rows.mapNotNull { (gatewayId, row) -> noticeOf(gatewayId, row, idOf, missText) }
	val live = rows.mapTo(HashSet()) { (gatewayId, row) -> idOf(gatewayId, row.routine.id) }
	val told = notices.mapTo(HashSet()) { it.id }
	val cancel = shade.filter { held ->
		val owner = held.gatewayId
		when {
			held.id in told -> false
			held.id in live -> true
			owner == null -> everyListed
			else -> owner in answered || (registry.current && !registry.has(owner))
		}
	}
	return RoutineNoticePlan(cancel.mapTo(HashSet()) { it.id }, notices)
}

private fun noticeOf(
	gatewayId: String,
	row: RoutineState,
	idOf: (String, String) -> Int,
	missText: (String) -> String,
): RoutineNotice? {
	val id = idOf(gatewayId, row.routine.id)
	row.missed?.let { return RoutineNotice(id, gatewayId, row, "${row.routine.name} did not run", missText(it.reason)) }
	if (row.reviewAt == null) return null
	val why = row.reviewReason?.replaceFirstChar { it.uppercase() } ?: "Its runbook could not run"
	return RoutineNotice(id, gatewayId, row, "${row.routine.name} stopped", why)
}
