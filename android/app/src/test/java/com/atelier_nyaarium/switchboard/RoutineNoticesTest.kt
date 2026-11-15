package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineMiss
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import org.junit.Assert.assertEquals
import org.junit.Test

class RoutineNoticesTest {
	private fun routine(id: String) = Routine(
		id = id,
		name = id,
		weekdays = listOf(1L),
		weekInterval = 1L,
		startDate = "2026-01-05",
		time = "09:00",
		zone = "America/Los_Angeles",
		runbookId = "book",
		approvedRevision = 1L,
		values = kotlinx.serialization.json.JsonObject(emptyMap()),
		target = RoutineTarget(spawn = "host"),
		linkedEntries = emptyList(),
		enabled = true,
		revision = 1L,
		since = 0L,
		forgetAfterDays = 30L,
	)

	private val missed = RoutineState(routine("triage"), missed = RoutineMiss("7", 100L, "gateway_down", runnable = true))
	private val quiet = RoutineState(routine("backup"))
	private val stopped = RoutineState(routine("digest"), reviewAt = 5L, reviewReason = "its runbook moved on")

	private val idOf = { gatewayId: String, routineId: String -> "$gatewayId/$routineId".hashCode() }

	private fun registry(
		provenance: RegistryProvenance = RegistryProvenance.Current,
		vararg lists: Pair<String, GatewayList<RoutineState>>,
	) = GatewayRegistry(
		provenance = provenance,
		gateways = lists.map { (id, list) -> GatewayEntry(id, connected = true, incarnation = 1L, lastRegisteredAt = 1L, routines = list) },
	)

	private fun plan(registry: GatewayRegistry, vararg shade: ShadeRoutine) =
		routineNoticePlan(registry, shade.toList(), idOf) { reason -> "missed: $reason" }

	@Test
	fun aGatewayThatHasNotAnsweredKeepsItsNotificationsWhileOneThatAnsweredSweepsItsOwn() {
		val listed = GatewayList.Listed(listOf(missed, quiet, stopped))
		val registry = registry(RegistryProvenance.Current, "sakura" to listed, "mikan" to GatewayList.Unread)
		val plan = plan(
			registry,
			ShadeRoutine(idOf("mikan", "nightly"), "mikan"),
			ShadeRoutine(idOf("sakura", "deleted"), "sakura"),
			ShadeRoutine(idOf("sakura", "backup"), "sakura"),
			ShadeRoutine(idOf("sakura", "triage"), "sakura"),
			ShadeRoutine(idOf("older", "posted before owners"), null),
		)

		assertEquals(setOf(idOf("sakura", "deleted"), idOf("sakura", "backup")), plan.cancel)
		assertEquals(
			listOf("triage did not run" to "missed: gateway_down", "digest stopped" to "Its runbook moved on"),
			plan.post.map { it.title to it.text },
		)
		assertEquals(listOf("sakura", "sakura"), plan.post.map { it.gatewayId })
	}

	@Test
	fun anUnownedNotificationGoesOnceEveryGatewayAnsweredAndALeftGatewaysGoWithACurrentRoster() {
		val unowned = ShadeRoutine(idOf("older", "posted before owners"), null)
		val left = ShadeRoutine(idOf("gone", "nightly"), "gone")
		val listed = GatewayList.Listed(emptyList<RoutineState>())

		assertEquals(setOf(unowned.id, left.id), plan(registry(RegistryProvenance.Current, "sakura" to listed), unowned, left).cancel)
		assertEquals(emptySet<Int>(), plan(registry(RegistryProvenance.Cached, "sakura" to GatewayList.Unread), unowned, left).cancel)
		assertEquals(setOf(left.id), plan(registry(RegistryProvenance.Current, "sakura" to GatewayList.Unread), unowned, left).cancel)
		// No roster says nothing about anybody.
		assertEquals(emptySet<Int>(), plan(GatewayRegistry(), unowned, left).cancel)
	}
}
