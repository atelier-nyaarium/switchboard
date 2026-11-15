package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.liveconsole.ConsoleToken
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleTokenKind
import com.atelier_nyaarium.switchboard.liveconsole.lexConsole
import com.atelier_nyaarium.switchboard.proto.ConsoleBuiltinDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleBuiltinParam
import com.atelier_nyaarium.switchboard.proto.ConsoleCut
import com.atelier_nyaarium.switchboard.proto.ConsoleDescribeResult
import com.atelier_nyaarium.switchboard.proto.ConsoleDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleDeviceIds
import com.atelier_nyaarium.switchboard.proto.ConsoleEntityDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleEvalResult
import com.atelier_nyaarium.switchboard.proto.ConsoleIds
import com.atelier_nyaarium.switchboard.proto.ConsoleIssue
import com.atelier_nyaarium.switchboard.proto.ConsoleLabelledId
import com.atelier_nyaarium.switchboard.proto.ConsoleMemberDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleParamDescription
import com.atelier_nyaarium.switchboard.proto.ConsoleResultItem
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

private const val CONSOLE_ROUND_TRIP_MS = 400L
private const val SANDBOX_HASH = "sandbox"

private val DEVICE = ConsoleParamDescription("device", "Text", "Id or name.", false, "devices")

private fun property(name: String, returns: String, description: String) =
	ConsoleMemberDescription(name, "property", returns, description, emptyList(), false)

private fun method(name: String, returns: String, description: String, vararg params: ConsoleParamDescription) =
	ConsoleMemberDescription(name, "method", returns, description, params.toList(), false)

private val SANDBOX_DESCRIPTION =
	ConsoleDescription(
		builtins =
			listOf(
				ConsoleBuiltinDescription("count", "collection", emptyList(), "Number", "Items in a list, or fields in a record."),
				ConsoleBuiltinDescription("first", "list", emptyList(), "Item or none", "The first item."),
				ConsoleBuiltinDescription("take", "list", listOf(ConsoleBuiltinParam("n", "Number")), "List", "The first n items."),
			),
		entities =
			listOf(
				ConsoleEntityDescription(
					"devices",
					"Devices this Gateway holds.",
					false,
					listOf(
						property("list", "List<Device>", "Every device, plugs and sensors."),
						method("get", "Device", "One device.", DEVICE),
					),
				),
				ConsoleEntityDescription(
					"sensors",
					"Paired sensors, readings in the owner's unit.",
					false,
					listOf(
						property("list", "List<SensorSummary>", "Every sensor, its main reading and when heard."),
						method("read", "Sensor", "Readings now, with 24-hour lows and highs.", DEVICE),
						method(
							"extremes",
							"Extremes",
							"One reading's 24-hour low and high.",
							DEVICE,
							ConsoleParamDescription("key", "Text", "Reading key.", false, "readings"),
						),
					),
				),
				ConsoleEntityDescription(
					"automations",
					"Automations and what they did.",
					false,
					listOf(property("runs", "List<Run>", "Recent runs, newest first.")),
				),
			),
	)

private val SANDBOX_IDS =
	ConsoleIds(
		devices =
			listOf(
				ConsoleDeviceIds("ce:1c:44:06:3c:5d", "Outside thermometer", listOf("temperature", "humidity", "battery")),
				ConsoleDeviceIds("d5:9f:c0:86:0b:32", "My room thermometer", listOf("temperature", "humidity", "battery")),
			),
		fields = listOf(ConsoleLabelledId("threshold-ce1c44063c5d-temperature", "Outside thermometer temperature")),
		automations = listOf(ConsoleLabelledId("threshold-ce1c44063c5d-temperature-low", "Outside thermometer temperature below 2.0 °C")),
		sources = listOf(ConsoleLabelledId("github", "GitHub notifications")),
		definitions = listOf("govee-h5110"),
	)

internal class SandboxLiveConsoleGateway(private val now: () -> Long = System::currentTimeMillis) : LiveConsoleGateway {
	override suspend fun describe(gatewayId: String): ConsoleCall<ConsoleDescribeResult> {
		delay(CONSOLE_ROUND_TRIP_MS)
		return ConsoleCall.Answered(ConsoleDescribeResult(SANDBOX_DESCRIPTION, SANDBOX_HASH))
	}

	override suspend fun ids(gatewayId: String): ConsoleCall<ConsoleIds> {
		delay(CONSOLE_ROUND_TRIP_MS)
		return ConsoleCall.Answered(SANDBOX_IDS)
	}

	override suspend fun eval(gatewayId: String, expr: String, variables: JsonObject?): ConsoleCall<ConsoleEvalResult> {
		delay(CONSOLE_ROUND_TRIP_MS)
		val refused = { code: String, message: String ->
			ConsoleCall.Answered(ConsoleEvalResult.Error(ConsoleIssue(code, 0, expr.length.toLong(), message), SANDBOX_HASH))
		}
		val saves = variables.orEmpty().mapNotNull { (name, held) -> (held as? JsonObject)?.get("value")?.let { name to it } }.toMap(mutableMapOf())
		val results = mutableListOf<ConsoleResultItem>()
		for (tokens in statementsOf(expr)) {
			val equals = tokens.getOrNull(1)
			val target = tokens.first().takeIf { it.kind == ConsoleTokenKind.IDENT && equals?.kind == ConsoleTokenKind.OP && equals.text == "=" }
			val from = if (target == null) tokens.first().start else tokens.getOrNull(2)?.start ?: tokens.last().end
			val read = expr.substring(from, tokens.last().end)
			if (target != null && SANDBOX_DESCRIPTION.entities.any { it.name == target.text }) {
				return refused("name_taken", "${target.text} is an entity")
			}
			val item = itemOf(read, saves) ?: return refused("not_found", "the sandbox does not answer that")
			if (target != null) saves[target.text] = item.value
			results += item.copy(assigned = target?.text)
		}
		return ConsoleCall.Answered(ConsoleEvalResult.Ok(results, SANDBOX_HASH))
	}

	private fun statementsOf(expr: String): List<List<ConsoleToken>> {
		val statements = mutableListOf(mutableListOf<ConsoleToken>())
		for (token in lexConsole(expr)) {
			if (token.kind == ConsoleTokenKind.PUNCT && token.text == ";") statements += mutableListOf<ConsoleToken>() else statements.last() += token
		}
		return statements.filter { it.isNotEmpty() }
	}

	private fun itemOf(read: String, saves: Map<String, JsonElement>): ConsoleResultItem? {
		val at = now()
		val entity = SANDBOX_DESCRIPTION.entities.firstOrNull { it.name == read }
		val saved = saves[read]
		return when {
			entity != null -> ConsoleResultItem(value = JsonNull, entity = entity.name)
			saved != null -> ConsoleResultItem(value = saved)
			read.startsWith("sensors.read(") ->
				ConsoleResultItem(
					value =
						Json.parseToJsonElement(
							"""{"name":"Outside thermometer","id":"ce:1c:44:06:3c:5d","radio":"gateway","model":"H5110",
							"heardAt":${at - 4_000},"stale":null,"readings":[
							{"label":"Temperature","key":"temperature","value":64.6,"shown":"64.6 °F",
							"low":{"shown":"58.1 °F","at":${at - 40_000_000}},"high":{"shown":"71.4 °F","at":${at - 9_000_000}}},
							{"label":"Humidity","key":"humidity","value":48.2,"shown":"48.2%"},
							{"label":"Battery","key":"battery","value":100,"shown":"100%"}]}""",
						),
					type = "Sensor",
				)
			read.startsWith("automations.runs") ->
				ConsoleResultItem(
					value =
						Json.parseToJsonElement(
							"""[{"label":"Outside thermometer temperature below 2.0 °C","automation":"a","seq":9,"at":${at - 720_000},"outcome":"ran"},
							{"label":"Random thermometer temperature below 25.0 °C","automation":"b","seq":8,"at":${at - 7_200_000},"outcome":"ran"},
							{"label":"Random thermometer temperature below 25.0 °C","automation":"b","seq":7,"at":${at - 7_300_000},"outcome":"suppressed"}]""",
						),
					type = "List<Run>",
					cut = ConsoleCut(3, 12),
				)
			read == "sensors.list.count()" -> ConsoleResultItem(value = Json.parseToJsonElement("3"))
			else -> null
		}
	}
}
