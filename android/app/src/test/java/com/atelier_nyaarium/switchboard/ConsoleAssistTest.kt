package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.ConsoleCompletion
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleVariable
import com.atelier_nyaarium.switchboard.liveconsole.variableShapes
import kotlinx.serialization.json.Json
import com.atelier_nyaarium.switchboard.liveconsole.VariableShape
import com.atelier_nyaarium.switchboard.liveconsole.applyTo
import com.atelier_nyaarium.switchboard.liveconsole.consoleAssist
import com.atelier_nyaarium.switchboard.proto.ConsoleBuiltinDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleBuiltinParam
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceIds
import com.atelier_nyaarium.switchboard.proto.ConsoleEntityDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleIds
import com.atelier_nyaarium.switchboard.proto.ConsoleMemberDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleParamDescription
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConsoleAssistTest {
	private fun param(name: String, description: String, completes: String? = null) =
		ConsoleParamDescription(name, "Text", description, false, completes)

	private fun method(name: String, vararg params: ConsoleParamDescription) =
		ConsoleMemberDescription(name, "method", "Sensor", "", params.toList(), false)

	private val description =
		ConsoleDescription(
			builtins =
				listOf(
					ConsoleBuiltinDescription("take", "list", listOf(ConsoleBuiltinParam("n", "Number")), "List", "The first n items."),
					ConsoleBuiltinDescription("first", "list", emptyList(), "Item or none", "The first item."),
				),
			entities =
				listOf(
					ConsoleEntityDescription(
						"sensors",
						"Paired sensors.",
						false,
						listOf(
							ConsoleMemberDescription("list", "property", "List<Sensor>", "", emptyList(), false),
							method("read", param("device", "Id or name.", "devices")),
							method("extremes", param("device", "Id or name.", "devices"), param("key", "Reading key.", "readings")),
						),
					),
					ConsoleEntityDescription(
						"definitions",
						"Definitions.",
						true,
						listOf(method("get", param("key", "Definition key.", "definitions")), method("match", param("advert", "An advert."))),
					),
				),
		)

	private val ids =
		ConsoleIds(
			devices =
				listOf(
					ConsoleDeviceIds("ce:1c", "Freezer", listOf("temperature", "battery")),
					ConsoleDeviceIds("d5:9f", "Fridge", listOf("humidity")),
				),
			fields = emptyList(),
			automations = emptyList(),
			sources = emptyList(),
			definitions = listOf("govee-h5110"),
		)

	private fun at(source: String, variables: Map<String, VariableShape?> = emptyMap(), cursor: Int = source.length) =
		consoleAssist(source, cursor, description, ids, variables)

	private fun labels(source: String, variables: Map<String, VariableShape?> = emptyMap()) =
		at(source, variables).completions.map { it.label }

	private val saved =
		mapOf(
			"outside" to VariableShape(listOf("name", "readings"), list = false),
			"runs" to VariableShape(emptyList(), list = true),
			"n" to null,
		)

	@Test
	fun namesAtTheStartAreVariablesThenEntities() {
		assertEquals(listOf("n", "outside", "runs", "sensors", "definitions"), labels("", saved))
		assertEquals(listOf(ConsoleCompletion("sensors", "sensors", 0, 3)), at("sen").completions)
		assertEquals(listOf("outside"), labels("1 + ou", saved))
		assertEquals(listOf("name", "readings"), labels("outside.", saved))
		val odd = variableShapes(mapOf("x" to ConsoleVariable(Json.parseToJsonElement("""{"bad-key":1,"good":2}"""), null)))
		assertEquals(listOf("good"), labels("x.", odd))
		assertEquals(listOf("take", "first"), labels("runs.", saved))
		assertEquals(emptyList<String>(), labels("n.", saved))
	}

	@Test
	fun aDotOffersTheEntitysMembersOrTheBuiltins() {
		assertEquals(listOf("list", "read", "extremes"), labels("sensors."))
		assertEquals(listOf(ConsoleCompletion("read", "read(", 8, 10)), at("sensors.re").completions)
		assertEquals("sensors.read(" to 13, at("sensors.re").completions.single().applyTo("sensors.re"))
		assertEquals(listOf("list", "read(", "extremes("), at("sensors.").completions.map { it.insert })
		assertEquals(listOf("take"), labels("sensors.list.ta"))
	}

	@Test
	fun aCallHintsItsParameterAndOffersLiveIds() {
		val open = at("sensors.read(")
		assertEquals("sensors.read", open.hint?.name)
		assertEquals(0, open.hint?.active)
		assertEquals(listOf("\"Freezer\"", "\"Fridge\""), open.completions.map { it.insert })

		val typed = at("sensors.read(\"Fr")
		assertEquals(listOf(ConsoleCompletion("Freezer", "\"Freezer\"", 13, 16), ConsoleCompletion("Fridge", "\"Fridge\"", 13, 16)), typed.completions)

		val second = at("sensors.extremes(\"Freezer\", ")
		assertEquals(1, second.hint?.active)
		assertEquals("key: Reading key.", second.hint?.note)
		assertEquals(listOf("temperature", "battery"), second.completions.map { it.label })

		assertEquals(listOf("govee-h5110"), labels("definitions.get("))
		assertEquals(emptyList<String>(), labels("definitions.match("))
		assertEquals("take", at("sensors.list.take(").hint?.name)
	}

	@Test
	fun aCompletionInsideATokenReplacesTheWholeToken() {
		val member = at("sensors.list", cursor = 10).completions.single()
		assertEquals("sensors.list" to 12, member.applyTo("sensors.list"))
		val source = "sensors.read(\"Freezer\")"
		val named = at(source, cursor = 18).completions.single { it.label == "Freezer" }
		assertEquals(source to 22, named.applyTo(source))
		assertEquals("sensors.list" to 12, at("sensors.list", cursor = 8).completions.first().applyTo("sensors.list"))
		val open = "sensors.read(\"Fr); x"
		assertEquals("sensors.read(\"Freezer\"); x" to 22, at(open, cursor = 16).completions.first().applyTo(open))
	}

	@Test
	fun eachStatementCompletesOnItsOwnAndSeesEarlierSaves() {
		assertEquals(listOf("cold", "sensors", "definitions"), labels("cold = sensors.list; "))
		assertEquals(listOf("list", "read", "extremes"), labels("cold = 1; sensors."))
		assertEquals("sensors.read", at("x = [1, 2]; sensors.read(").hint?.name)
		assertEquals(listOf("take", "first"), labels("cold = sensors.list; cold."))
	}

	@Test
	fun aSharedDeviceNameCompletesAsItsId() {
		val twins = ids.copy(devices = ids.devices + ConsoleDeviceIds("aa:bb", "Fridge", emptyList()))
		val offered = consoleAssist("sensors.read(", 13, description, twins, emptyMap()).completions
		assertEquals(listOf("\"Freezer\"", "\"d5:9f\"", "\"aa:bb\""), offered.map { it.insert })
		assertEquals("Fridge · d5:9f", offered[1].label)
		val typed = consoleAssist("sensors.read(\"Fr", 16, description, twins, emptyMap()).completions
		assertEquals(listOf("Freezer", "Fridge · d5:9f", "Fridge · aa:bb"), typed.map { it.label })
	}

	@Test
	fun aFinishedValueOffersNothing() {
		val closed = at("sensors.read(\"Freezer\")")
		assertNull(closed.hint)
		assertEquals(emptyList<ConsoleCompletion>(), closed.completions)
		assertEquals(emptyList<ConsoleCompletion>(), at("sensors.list ").completions)
		assertEquals(emptyList<ConsoleCompletion>(), consoleAssist("sen", 3, null, ids, emptyMap()).completions)
	}
}
