package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.ConsoleCard
import com.atelier_nyaarium.switchboard.liveconsole.EntryDrawn
import com.atelier_nyaarium.switchboard.liveconsole.canRun
import com.atelier_nyaarium.switchboard.liveconsole.entryDrawn
import com.atelier_nyaarium.switchboard.liveconsole.memberInsert
import com.atelier_nyaarium.switchboard.liveconsole.memberSignature
import com.atelier_nyaarium.switchboard.liveconsole.moreLine
import com.atelier_nyaarium.switchboard.liveconsole.picksGateway
import com.atelier_nyaarium.switchboard.proto.ConsoleMemberDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleParamDescription
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleDrawn
import com.atelier_nyaarium.switchboard.liveconsole.oneLine
import com.atelier_nyaarium.switchboard.liveconsole.withVariable
import com.atelier_nyaarium.switchboard.liveconsole.cardsOf
import com.atelier_nyaarium.switchboard.liveconsole.vocabularyLine
import com.atelier_nyaarium.switchboard.proto.ConsoleResultItem
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleVariable
import com.atelier_nyaarium.switchboard.liveconsole.variableLabel
import com.atelier_nyaarium.switchboard.liveconsole.consoleGatewayOf
import com.atelier_nyaarium.switchboard.proto.ConsoleCut
import com.atelier_nyaarium.switchboard.proto.ConsoleDescribeResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEntityDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEvalResult
import com.atelier_nyaarium.switchboard.proto.ConsoleIds
import com.atelier_nyaarium.switchboard.proto.ConsoleIssue
import com.atelier_nyaarium.switchboard.proto.Protocol
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveConsoleTest {
	private val now = 1_794_695_000_000L
	private val description =
		ConsoleDescription(emptyList(), listOf(ConsoleEntityDescription("devices", "Devices this Gateway holds.", false, emptyList())))

	private fun item(json: String, type: String? = null, cut: ConsoleCut? = null, assigned: String? = null) =
		ConsoleResultItem(value = Json.parseToJsonElement(json), type = type, cut = cut, assigned = assigned)

	private fun ok(json: String, type: String? = null, cut: ConsoleCut? = null) =
		ConsoleEvalResult.Ok(listOf(item(json, type, cut)), "h1")

	private fun cardOf(result: ConsoleEvalResult) = cardsOf(result, description, now).single().card

	@Test
	fun aSensorReadsAsReadingsInTheOwnersUnit() {
		val sensor =
			"""{"name":"Outside","model":"H5110","radio":"gateway","heardAt":${now - 60_000},"stale":null,
			"readings":[{"label":"Temperature","key":"temperature","value":64.6,"shown":"64.6 °F",
			"low":{"shown":"58.1 °F","at":1},"high":{"shown":"71.4 °F","at":2}},
			{"label":"Battery","key":"battery","value":100,"shown":"100%"}]}"""
		val card = cardOf(ok(sensor, "Sensor")) as ConsoleCard.Sensor
		assertEquals("H5110 · gateway radio · 1 min ago", card.line)
		assertEquals(listOf("64.6 °F", "100%"), card.readings.map { it.shown })
		assertEquals("24 h: low 58.1 °F · high 71.4 °F", card.readings.first().range)
	}

	@Test
	fun aListReadsAsRowsAndSaysWhatTheCutLeft() {
		val runs =
			"""[{"label":"Outside below 2.0 °C","outcome":"ran","at":${now - 720_000},"seq":4},
			{"label":"Random below 25.0 °C","outcome":"suppressed","at":${now - 7_200_000}}]"""
		val card = cardOf(ok(runs, "List<Run>", ConsoleCut(2, 9))) as ConsoleCard.Rows
		assertEquals("List<Run> · 9 items", card.heading)
		assertEquals(7L, card.more)
		assertEquals(listOf("ran", "suppressed"), card.rows.map { it.tag })
		assertEquals(listOf("12 min ago", "2 h ago"), card.rows.map { it.trailing })
		assertEquals("seq 4", card.rows.first().detail)
	}

	@Test
	fun anEntityAnErrorARecordAndAScalarEachDrawTheirOwnWay() {
		val entity = ConsoleEvalResult.Ok(listOf(ConsoleResultItem(value = JsonNull, entity = "devices")), "h1")
		assertEquals(description.entities.first(), (cardOf(entity) as ConsoleCard.Schema).entity)
		val issue = ConsoleIssue("not_found", 0, 21, "no device Garage")
		assertEquals(issue, (cardOf(ConsoleEvalResult.Error(issue, "h1")) as ConsoleCard.Failed).issue)
		val record = cardOf(ok("""{"id":"x","heardAt":${now - 5_000},"nested":{"on":true}}"""))
		assertEquals(
			listOf("id" to "x", "heardAt" to "5 s ago", "nested" to null, "on" to "yes"),
			(record as ConsoleCard.Fields).lines.map { it.key to it.text },
		)
		assertEquals(ConsoleCard.Scalar("27"), cardOf(ok("27")))
	}

	@Test
	fun eachStatementDrawsItsOwnCardAndASaveIsNamed() {
		val both = ConsoleEvalResult.Ok(listOf(item("4", assigned = "n"), item("\"two\\nlines\"")), "h1")
		assertEquals(
			listOf(ConsoleDrawn(ConsoleCard.Scalar("4"), "n"), ConsoleDrawn(ConsoleCard.Scalar("two lines"), null)),
			cardsOf(both, description, now),
		)
		val nested = cardOf(ok("""[[1, 2], {"name":"x","at":"1794694999000"}, {"at":3}]""")) as ConsoleCard.Rows
		assertEquals(listOf("2 items", "x", "{1 fields}"), nested.rows.map { it.title })
		assertEquals(listOf(null, null, null), nested.rows.map { it.trailing })
	}

	@Test
	fun aRowDrawsItsWaitItsRefusalOrItsCardsAndAMemberTypesItsCall() {
		assertEquals(EntryDrawn.Running, entryDrawn(ConsoleEntryState.Running, description, now))
		assertEquals(EntryDrawn.Said("no such op"), entryDrawn(ConsoleEntryState.Refused("no such op"), description, now))
		val answered = entryDrawn(ConsoleEntryState.Answered(ok("27")), description, now)
		assertEquals(EntryDrawn.Cards(listOf(ConsoleDrawn(ConsoleCard.Scalar("27"), null))), answered)

		val cut = cardOf(ok("""[{"label":"a"},{"label":"b"}]""", "List<Run>", ConsoleCut(2, 9))) as ConsoleCard.Rows
		assertEquals("7 more; add .skip(2)", moreLine(cut))
		assertEquals(null, moreLine(cardOf(ok("""[{"label":"a"}]""")) as ConsoleCard.Rows))

		val entity = description.entities.first()
		val read = ConsoleMemberDescription(
			"read",
			"method",
			"Sensor",
			"",
			listOf(ConsoleParamDescription("device", "Text", "", false, null), ConsoleParamDescription("at", "Number", "", true, null)),
			false,
		)
		val list = ConsoleMemberDescription("list", "property", "List<Device>", "", emptyList(), false)
		assertEquals("read(device: Text, at?: Number) -> Sensor", memberSignature(read))
		assertEquals("${entity.name}.read(", memberInsert(entity, read))
		assertEquals("${entity.name}.list", memberInsert(entity, list))
		assertTrue(canRun(" devices ") && !canRun("  "))
	}

	@Test
	fun aConversationReadsItsOwnGatewayAndTheWholeViewKeepsAPickTheRosterNames() {
		val roster =
			GatewayRegistry(
				provenance = RegistryProvenance.Current,
				gateways = listOf(GatewayEntry("sakura", false, 1, 0), GatewayEntry("tsubaki", true, 1, 0)),
			)
		assertEquals("tsubaki", consoleGatewayOf(ViewScope.Everything, roster, null))
		assertEquals("sakura", consoleGatewayOf(ViewScope.Everything, roster, "sakura"))
		assertEquals("tsubaki", consoleGatewayOf(ViewScope.Everything, roster, "gone"))
		assertEquals("sakura", consoleGatewayOf(ViewScope.Session("dom.sakura.host.abc123"), roster, "tsubaki"))
		assertTrue(picksGateway(ViewScope.Everything, roster))
		assertTrue(!picksGateway(ViewScope.Session("dom.sakura.host.abc123"), roster))
	}

	private class Host(override val gateway: LiveConsoleGateway?, private val named: Boolean = true) : LiveConsoleHost {
		override val generation = WorkspaceGeneration()

		override fun names(gatewayId: String) = named
	}

	private class FakeGateway : LiveConsoleGateway {
		var hash = "h1"
		var describes = 0
		val held = CompletableDeferred<ConsoleEvalResult>()

		var refuses: String? = null
		var idReads = 0
		var entities = emptyList<String>()
		val carried = mutableListOf<JsonObject?>()

		override suspend fun describe(gatewayId: String): ConsoleCall<ConsoleDescribeResult> {
			describes++
			refuses?.let { return ConsoleCall.Refused(it) }
			val held = entities.map { ConsoleEntityDescription(it, "", false, emptyList()) }
			return ConsoleCall.Answered(ConsoleDescribeResult(ConsoleDescription(emptyList(), held), hash))
		}

		override suspend fun ids(gatewayId: String): ConsoleCall<ConsoleIds> {
			idReads++
			return ConsoleCall.Answered(
				ConsoleIds(devices = emptyList(), fields = emptyList(), automations = emptyList(), sources = emptyList(), definitions = listOf("govee-h5110")),
			)
		}

		val sent = mutableListOf<Set<String>>()

		override suspend fun eval(gatewayId: String, expr: String, variables: JsonObject?): ConsoleCall<ConsoleEvalResult> {
			sent += variables?.keys.orEmpty()
			carried += variables
			refuses?.let { return ConsoleCall.Refused(it) }
			val saved = expr.substringBefore(" = ", "")
			return ConsoleCall.Answered(
				when {
					expr == "slow" -> held.await()
					expr.endsWith(" = big") ->
						ConsoleEvalResult.Ok(
							listOf(ConsoleResultItem(value = JsonPrimitive("x".repeat(60_000)), assigned = saved)),
							hash,
						)
					expr.endsWith(" = 4") ->
						ConsoleEvalResult.Ok(listOf(ConsoleResultItem(value = JsonPrimitive(4), assigned = saved)), hash)
					expr == "gone.member" -> ConsoleEvalResult.Error(ConsoleIssue("no_member", 0, 11, "gone"), hash)
					expr.startsWith("cold = ") ->
						ConsoleEvalResult.Ok(
							listOf(ConsoleResultItem(value = JsonPrimitive(-18), type = "Number", assigned = "cold")),
							hash,
						)
					else -> ConsoleEvalResult.Ok(listOf(ConsoleResultItem(value = JsonNull)), hash)
				},
			)
		}
	}

	@Test
	fun anAnswerLandsOnItsOwnEntryAndANewVocabularyIsReadAgain() = runBlocking {
		val gateway = FakeGateway()
		val ops = LiveConsoleOps(Host(gateway))
		ops.open("sakura")
		assertEquals(listOf("govee-h5110"), ops.viewOf("sakura").ids?.definitions)
		val slow = async { ops.run("sakura", "slow") }
		while (ops.viewOf("sakura").entries.isEmpty()) kotlinx.coroutines.yield()
		ops.run("sakura", " devices ")
		gateway.held.complete(ConsoleEvalResult.Error(ConsoleIssue("too_big", 0, 4, "over"), "h1"))
		slow.await()
		val entries = ops.viewOf("sakura").entries
		assertEquals(listOf("slow", "devices"), entries.map { it.expr })
		assertTrue((entries.first().state as ConsoleEntryState.Answered).result is ConsoleEvalResult.Error)
		assertEquals(listOf("devices", "slow"), ops.recall("sakura"))
		assertEquals(1, gateway.describes)
		gateway.hash = "h2"
		ops.run("sakura", "gone.member")
		assertEquals(2, gateway.describes)
		assertEquals("h2", ops.viewOf("sakura").registryHash)
		assertEquals(4, gateway.idReads)
	}

	@Test
	fun aReadBegunBeforeAReprovisionLandsNothingAfterIt() = runBlocking {
		val gateway = FakeGateway()
		val ops = LiveConsoleOps(Host(gateway))
		ops.run("sakura", "cold = 1")
		val slow = async { ops.run("sakura", "slow") }
		while (ops.viewOf("sakura").entries.size < 2) kotlinx.coroutines.yield()
		ops.clearInMemory()
		gateway.held.complete(ConsoleEvalResult.Ok(listOf(ConsoleResultItem(value = JsonPrimitive(7), assigned = "theirs")), "h1"))
		slow.await()
		assertEquals(LiveConsoleView(), ops.viewOf("sakura"))
		assertEquals(emptyMap<String, LiveConsoleView>(), ops.state.value)
	}

	@Test
	fun savedValuesTravelUnderWhatOneReadMayCarryOldestDroppedFirst() = runBlocking {
		val gateway = FakeGateway()
		val ops = LiveConsoleOps(Host(gateway))
		for (name in listOf("a", "b", "c", "d")) ops.run("sakura", "$name = big")
		ops.run("sakura", "a + b + c + d")
		val sent = gateway.carried.last()
		assertEquals(setOf("b", "c", "d"), sent?.keys)
		assertTrue(sent.toString().toByteArray().size <= Protocol.Wire.CONSOLE_VARIABLES_BYTES)
	}

	@Test
	fun aSavedNameTheGatewayTakesAsAnEntityIsDroppedAndStaysDropped() = runBlocking {
		val gateway = FakeGateway()
		val ops = LiveConsoleOps(Host(gateway))
		ops.open("sakura")
		ops.run("sakura", "gadgets = 4")
		assertEquals(setOf("gadgets"), ops.viewOf("sakura").variables.keys)
		gateway.entities = listOf("gadgets")
		gateway.hash = "h2"
		ops.run("sakura", "devices")
		assertEquals(emptySet<String>(), ops.viewOf("sakura").variables.keys)
		ops.run("sakura", "gadgets = 4")
		assertEquals(emptySet<String>(), ops.viewOf("sakura").variables.keys)
	}

	@Test
	fun eachSandboxGatewayAnswersItsOwnWay() = runBlocking {
		val ops = LiveConsoleOps(Host(SandboxLiveConsoleGateway(now = { now }, pause = {})))
		for (gatewayId in listOf("sandbox", SECOND_SANDBOX_GATEWAY, SANDBOX_NEVER_REGISTERED)) {
			ops.open(gatewayId)
			ops.run(gatewayId, "outside = sensors.read(\"Outside thermometer\")")
		}
		ops.run("sandbox", "1 + 1")

		val home = ops.viewOf("sandbox")
		assertEquals(ConsoleVocabulary.Ready, home.vocabulary)
		assertEquals(setOf("outside"), home.variables.keys)
		val unanswered = (home.entries.last().state as ConsoleEntryState.Answered).result
		assertTrue(unanswered is ConsoleEvalResult.Error)
		assertTrue(ops.viewOf(SECOND_SANDBOX_GATEWAY).vocabulary is ConsoleVocabulary.Refused)
		assertTrue(ops.viewOf(SECOND_SANDBOX_GATEWAY).entries.single().state is ConsoleEntryState.Refused)
		assertEquals(ConsoleVocabulary.Unreachable, ops.viewOf(SANDBOX_NEVER_REGISTERED).vocabulary)
		assertEquals(ConsoleEntryState.Unreachable, ops.viewOf(SANDBOX_NEVER_REGISTERED).entries.single().state)
	}

	@Test
	fun aGatewayTheRosterDoesNotNameIsAskedNothing() = runBlocking {
		val gateway = FakeGateway()
		val ops = LiveConsoleOps(Host(gateway, named = false))
		ops.open("gone")
		ops.run("gone", "devices")
		assertEquals(ConsoleEntryState.Unreachable, ops.viewOf("gone").entries.single().state)
		assertEquals(0, gateway.describes + gateway.idReads + gateway.sent.size)
	}

	@Test
	fun aGatewaysRefusalIsShownAsItsOwnWordNotAsSilence() = runBlocking {
		val gateway = FakeGateway().apply { refuses = "unknown op console_describe" }
		val ops = LiveConsoleOps(Host(gateway))
		ops.open("sakura")
		assertEquals(
			"This Gateway does not serve the console: unknown op console_describe",
			vocabularyLine(ops.viewOf("sakura").vocabulary),
		)
		ops.run("sakura", "devices")
		assertEquals(ConsoleEntryState.Refused("unknown op console_describe"), ops.viewOf("sakura").entries.single().state)
	}

	@Test
	fun aSavedResultIsKeptAndTravelsWithAnyReadThatNamesIt() = runBlocking {
		val gateway = FakeGateway()
		val ops = LiveConsoleOps(Host(gateway))
		ops.run("sakura", "cold = sensors.read(\"Freezer\").readings[0].value")
		assertEquals(mapOf("cold" to ConsoleVariable(JsonPrimitive(-18), "Number")), ops.viewOf("sakura").variables)
		assertEquals("Number", variableLabel(ops.viewOf("sakura").variables.getValue("cold")))
		ops.run("sakura", "devices")
		ops.run("sakura", "cold + 1")
		assertEquals(listOf(emptySet(), emptySet(), setOf("cold")), gateway.sent)
		ops.dropVariable("sakura", "cold")
		assertEquals(emptyMap<String, ConsoleVariable>(), ops.viewOf("sakura").variables)
	}

	@Test
	fun theHeldSetStaysUnderWhatOneReadMayCarry() {
		val big = { ConsoleVariable(JsonPrimitive("x".repeat(80_000)), null) }
		val kept = listOf("a", "b", "c").fold(emptyMap<String, ConsoleVariable>()) { all, name -> withVariable(all, name, big()) }
		assertEquals(listOf("b", "c"), kept.keys.toList())
	}

	@Test
	fun textDrawsOnOneLineKeepingWhatIsNotAsciiSpace() {
		val nbsp = Char(0xa0)
		assertEquals("Garage state: off", oneLine("Garage\n\tstate: off  "))
		assertEquals("${nbsp}name$nbsp", oneLine("${nbsp}name$nbsp"))
		val deep = cardsOf(ok("""{"x":[[[[1]]]],"at":9000000000000000}"""), description, now).single().card as ConsoleCard.Fields
		assertEquals(listOf("x" to null, "0" to null, "0" to "1 items", "at" to "9000000000000000"), deep.lines.map { it.key to it.text })
	}

	@Test
	fun noGatewayToReadAnswersUnreachable() = runBlocking {
		val ops = LiveConsoleOps(Host(null))
		ops.run("sakura", "devices")
		assertEquals(ConsoleEntryState.Unreachable, ops.viewOf("sakura").entries.single().state)
	}
}
