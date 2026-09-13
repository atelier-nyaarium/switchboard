package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.proto.VaultGrant
import com.atelier_nyaarium.switchboard.proto.VaultHolder
import com.atelier_nyaarium.switchboard.proto.VaultRequest
import com.atelier_nyaarium.switchboard.vault.VaultPendingRequest
import com.atelier_nyaarium.switchboard.vault.grantId
import org.junit.Assert.assertEquals
import org.junit.Test

class ViewScopeTest {
	private val here = ViewScope.Session("home.sakura.host.aaa")

	private fun routine(id: String, spawn: String) = RoutineState(
		Routine(
			id = id,
			name = id,
			weekdays = listOf(1L),
			weekInterval = 1L,
			startDate = "2026-01-05",
			time = "09:00",
			zone = "UTC",
			runbookId = "book",
			approvedRevision = 1L,
			values = kotlinx.serialization.json.JsonObject(emptyMap()),
			target = RoutineTarget(spawn = spawn),
			linkedEntries = emptyList(),
			enabled = true,
			revision = 1L,
			since = 0L,
		),
	)

	private fun request(id: String, team: String) = VaultPendingRequest(
		team,
		VaultRequest.Typed(
			v = 1L,
			requestId = id,
			operation = "sudo apt install",
			displayShape = "sudo apt",
			coveredShapes = listOf("apt"),
			sessionTarget = localFieldOf(team),
			deadlineAt = 10L,
		),
		0L,
	)

	private fun grant(id: String, holder: VaultHolder) =
		VaultGrant.Session(grantId = id, entryId = "deploy", holder = holder, expiresAt = 10L)

	@Test
	fun `a session draws and creates on its own Gateway, and the root on every one`() {
		val registry = testRegistry("mikan", "sakura")

		assertEquals(listOf("sakura"), here.groupsOf(registry.gateways).map { it.id })
		assertEquals(listOf("sakura"), here.newOn(registry))
		assertEquals(listOf("mikan", "sakura"), ViewScope.Everything.newOn(registry))
		assertEquals(emptyList<String>(), here.newOn(testRegistry("mikan")))
	}

	@Test
	fun `a session's routines are those that start on its spawn point`() {
		val rows = listOf(routine("nightly", "host"), routine("backup", "nas"), routine("routine-sweep", "host"))

		assertEquals(listOf("nightly", "routine-sweep"), here.routinesOf(rows).map { it.routine.id })
		assertEquals(rows, ViewScope.Everything.routinesOf(rows))
	}

	@Test
	fun `a session's requests and grants are the ones it holds`() {
		val pending = listOf(request("mine", "home.sakura.host.aaa"), request("theirs", "home.sakura.host.bbb"))
		val grants = mapOf(
			"sakura" to listOf(
				grant("mine", VaultHolder.Session("host.aaa")),
				grant("sibling", VaultHolder.Session("host.bbb")),
				grant("routine", VaultHolder.Routine("host.aaa")),
			),
			// The same local name on another Gateway is another session.
			"mikan" to listOf(grant("elsewhere", VaultHolder.Session("host.aaa"))),
		)

		assertEquals(listOf("mine"), here.requestsOf(pending).map { it.requestId })
		assertEquals(listOf("sakura" to "mine"), here.grantsOf(grants).map { (gateway, it) -> gateway to it.grantId })
		assertEquals(4, ViewScope.Everything.grantsOf(grants).size)
	}
}
