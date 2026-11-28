package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.AuthorizationPolicy
import com.atelier_nyaarium.switchboard.proto.PolicyBinding
import com.atelier_nyaarium.switchboard.proto.Routine
import com.atelier_nyaarium.switchboard.proto.RoutineState
import com.atelier_nyaarium.switchboard.proto.RoutineTarget
import com.atelier_nyaarium.switchboard.proto.Runbook
import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayScopedStateTest {
	private fun book(id: String, name: String) =
		Runbook(id = id, name = name, body = "do it", parameters = emptyList(), revision = 1L)

	private fun routine(id: String, name: String) = Routine(
		id = id,
		name = name,
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
		forgetAfterDays = 7L,
		enabled = true,
		revision = 1L,
		since = 0L,
	)

	private val state = testRegistry("sakura", "mikan")
		.withEntry("sakura") {
			it.copy(
				runbooks = GatewayList.Listed(listOf(book("shared", "Here"))),
				routines = GatewayList.Listed(listOf(RoutineState(routine("triage", "Here"), nextAt = 900L))),
				policies = GatewayList.Listed(listOf(policy("apt", "Here"))),
			)
		}
		.withEntry("mikan") {
			it.copy(
				runbooks = GatewayList.Listed(listOf(book("shared", "There"), book("only-there", "Only there"))),
				routines = GatewayList.Listed(listOf(RoutineState(routine("triage", "There"), nextAt = 300L))),
				policies = GatewayList.Listed(listOf(policy("apt", "There"))),
			)
		}

	private fun policy(id: String, name: String) = AuthorizationPolicy(
		id = id,
		name = name,
		binding = PolicyBinding(entryId = "deploy"),
		selectorKeys = listOf("sudo apt"),
		enabled = true,
		revision = 1L,
	)

	@Test
	fun oneIdOnTwoGatewaysReadsAsTwoRecords() {
		assertEquals("Here", state.runbookOn("sakura", "shared").found()?.name)
		assertEquals("There", state.runbookOn("mikan", "shared").found()?.name)
		assertEquals("Here", state.routineOn("sakura", "triage").found()?.routine?.name)
		assertEquals("There", state.routineOn("mikan", "triage").found()?.routine?.name)
		assertEquals("Here", state.policyOn("sakura", "apt").found()?.name)
		assertEquals("There", state.policyOn("mikan", "apt").found()?.name)
	}

	@Test
	fun aRecordOnAnotherGatewayIsNotFoundUnderThisOne() {
		assertEquals(Lookup.Gone, state.runbookOn("sakura", "only-there"))
		assertEquals(Lookup.Gone, state.routineOn("sakura", "nothing"))
		assertEquals(Lookup.Gone, state.policyOn("sakura", "nothing"))
		// Off the roster once it loaded.
		assertEquals(Lookup.Unreachable, state.runbookOn("unknown", "shared"))
		assertEquals(Lookup.Unreachable, state.routineOn("unknown", "triage"))
		assertEquals(Lookup.Unreachable, state.policyOn("unknown", "apt"))
		assertEquals(GatewayList.Unreachable, state.listOn("unknown") { it.automations })
		val unloaded = GatewayRegistry()
		assertEquals(Lookup.Reading, unloaded.automationOn("sakura", "a"))
		assertEquals(GatewayList.Unread, unloaded.listOn("sakura") { it.runbooks })
	}

	@Test
	fun onlyAFoundRecordFiresLabelsOrRebases() {
		val unread = GatewayRegistry()
		assertEquals("Here", com.atelier_nyaarium.switchboard.runbooks.fireable(state.runbookOn("sakura", "shared"))?.name)
		assertEquals(null, com.atelier_nyaarium.switchboard.runbooks.fireable(unread.runbookOn("sakura", "shared")))
		assertEquals("Here", com.atelier_nyaarium.switchboard.vault.policyLabel(state.policyOn("sakura", "apt"), "apt"))
		assertEquals("apt", com.atelier_nyaarium.switchboard.vault.policyLabel(unread.policyOn("sakura", "apt"), "apt"))
		assertEquals(null, foundRow(unread.automationOn("sakura", "a")))
	}

	@Test
	fun everyReaderTellsUnreadUnreachableNotServedAndListedWithNone() {
		val lookups = listOf(Lookup.Reading, Lookup.Unreachable, Lookup.NotServed, Lookup.Gone)
		val lists = listOf(GatewayList.Unread, GatewayList.Unreachable, GatewayList.NotServed, GatewayList.Listed(emptyList<Runbook>()))
		val none = assistantState()

		assertEquals(listOf(null, null, null, null), lookups.map { com.atelier_nyaarium.switchboard.runbooks.fireable(it) })
		assertEquals(listOf("apt", "apt", "apt", "apt"), lookups.map { com.atelier_nyaarium.switchboard.vault.policyLabel(it, "apt") })
		assertEquals(listOf(null, null, null, null), lookups.map { foundRow(it) })
		val shelves = lists.map { com.atelier_nyaarium.switchboard.routines.runbookShelf(it) }
		assertEquals(listOf(true, true, true, false), shelves.map { it.line != null })
		assertEquals(4, shelves.map { it.line }.distinct().size)
		assertEquals(
			listOf(null, null, null),
			listOf(AssistantRead.Reading, AssistantRead.Refused, AssistantRead.Answered(none)).map { heldSource(it, "github") },
		)
	}

	@Test
	fun aRoutinePicksFromItsOwnGatewaysLibrary() {
		// Editor offers only its own Gateway's.
		assertEquals(listOf("Here"), state.entry("sakura")?.runbooks?.listedRows()?.map { it.name })
		assertEquals(listOf("There", "Only there"), state.entry("mikan")?.runbooks?.listedRows()?.map { it.name })
	}

	@Test
	fun anEmptyViewSaysWhetherItsListsWereReadFailedOrHoldNothing() {
		fun registry(vararg lists: GatewayList<Runbook>) = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = lists.mapIndexed { at, list -> GatewayEntry("g$at", connected = true, incarnation = 1, lastRegisteredAt = 1, runbooks = list) },
		)
		fun empty(registry: GatewayRegistry) = listEmpty(registry, registry.gateways) { it.runbooks }
		val none = GatewayList.Listed(emptyList<Runbook>())

		assertEquals(ListEmpty.NoRoster, empty(GatewayRegistry()))
		assertEquals(ListEmpty.Reading, empty(registry(GatewayList.Unread, GatewayList.Unreachable)))
		assertEquals(ListEmpty.Unreachable, empty(registry(GatewayList.Unreachable, GatewayList.NotServed)))
		assertEquals(ListEmpty.NotServed(listOf("g0")), empty(registry(GatewayList.NotServed)))
		assertEquals(ListEmpty.None, empty(registry(none, GatewayList.Unread)))
		assertEquals(ListEmpty.NoGateway, empty(registry()))
		// Only answered lists draw.
		val held = registry(GatewayList.Unread, GatewayList.Listed(listOf(book("a", "A"))), GatewayList.NotServed)
		assertEquals(listOf(ListedGroup("g1", listOf(book("a", "A")))), held.gateways.listedGroups { it.runbooks })
	}

	@Test
	fun aGroupedViewSaysNothingWholeOnceAGatewayListsAndNamesGroupsWithSeveralInScope() {
		fun registry(vararg lists: GatewayList<Runbook>) = GatewayRegistry(
			provenance = RegistryProvenance.Current,
			gateways = lists.mapIndexed { at, list -> GatewayEntry("g$at", connected = true, incarnation = 1, lastRegisteredAt = 1, runbooks = list) },
		)
		fun drawn(registry: GatewayRegistry) =
			groupedView(registry, registry.gateways) { it.runbooks } to registry.gateways.listedGroups { it.runbooks }.map { it.gatewayId to it.rows.size }
		val none = GatewayList.Listed(emptyList<Runbook>())
		val some = GatewayList.Listed(listOf(book("a", "A")))

		assertEquals(GroupedView(null, true) to listOf("g0" to 0), drawn(registry(none, GatewayList.Unread)))
		assertEquals(GroupedView(null, true) to listOf("g0" to 0), drawn(registry(none, GatewayList.Unreachable)))
		assertEquals(GroupedView(ListEmpty.Reading, true) to emptyList<Pair<String, Int>>(), drawn(registry(GatewayList.Unread, GatewayList.Unread)))
		assertEquals(GroupedView(null, false) to listOf("g0" to 0), drawn(registry(none)))
		assertEquals(GroupedView(null, true) to listOf("g0" to 1, "g1" to 0), drawn(registry(some, none)))
	}

	@Test
	fun thePhoneWakesForTheSoonestRunOnAnyGateway() {
		assertEquals(300L, state.soonestRoutineAt())
		// Nothing scheduled: no wake.
		assertEquals(null, GatewayRegistry().soonestRoutineAt())
	}

	@Test
	fun aNewRecordGoesOnlyToAGatewayTheCurrentRosterReaches() {
		val shelved = GatewayEntry("shelved", connected = false, incarnation = 0, lastRegisteredAt = 0)
		val away = GatewayEntry("away", connected = false, incarnation = 3, lastRegisteredAt = 9)
		val current = state.copy(gateways = state.gateways + shelved + away)
		// Drawn as groups, offered nothing.
		assertEquals(listOf("mikan", "sakura", "shelved", "away"), current.ids())
		assertEquals(listOf("mikan", "sakura"), current.reachableIds())
		assertEquals(false, current.reachable("shelved"))
		assertEquals(false, current.reachable("away"))
		// A cached roster draws and offers nothing.
		val cached = current.copy(provenance = RegistryProvenance.Cached)
		assertEquals(current.ids(), cached.ids())
		assertEquals(emptyList<String>(), cached.reachableIds())
		assertEquals(false, cached.reachable("sakura"))
	}

	@Test
	fun anAnswerForAGatewayTheRosterDoesNotNameDrawsNothing() {
		val written = state.withEntry("gone") { it.copy(runbooks = GatewayList.Listed(listOf(book("x", "X")))) }
		assertEquals(state, written)
		assertEquals(Lookup.Unreachable, written.runbookOn("gone", "x"))
	}
}
