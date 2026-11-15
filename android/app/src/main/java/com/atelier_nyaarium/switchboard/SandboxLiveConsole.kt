package com.atelier_nyaarium.switchboard

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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

private const val CONSOLE_ROUND_TRIP_MS = 400L
private const val SANDBOX_HASH = "sandbox"
private const val OLDER_GATEWAY = "unknown op console_describe"

private fun param(name: String, description: String, completes: String) =
	ConsoleParamDescription(name, "Text", description, false, completes)

private val DEVICE = param("device", "Id or name.", "devices")

private fun property(name: String, returns: String, description: String) =
	ConsoleMemberDescription(name, "property", returns, description, emptyList(), false)

private fun method(name: String, returns: String, description: String, vararg params: ConsoleParamDescription) =
	ConsoleMemberDescription(name, "method", returns, description, params.toList(), false)

private fun entity(name: String, description: String, vararg members: ConsoleMemberDescription) =
	ConsoleEntityDescription(name, description, false, members.toList())

private val SANDBOX_DESCRIPTION =
	ConsoleDescription(
		builtins =
			listOf(
				ConsoleBuiltinDescription("count", "collection", emptyList(), "Number", "Items in a list, or fields in a record."),
				ConsoleBuiltinDescription("first", "list", emptyList(), "Item or none", "The first item."),
				ConsoleBuiltinDescription("take", "list", listOf(ConsoleBuiltinParam("n", "Number")), "List", "The first n items."),
				ConsoleBuiltinDescription(
					"round",
					"none",
					listOf(ConsoleBuiltinParam("x", "Number"), ConsoleBuiltinParam("places", "Number", optional = true)),
					"Number",
					"x to that many decimals, none when left out.",
				),
				ConsoleBuiltinDescription(
					"if",
					"none",
					listOf(ConsoleBuiltinParam("when", "Yes/no"), ConsoleBuiltinParam("then", "Any"), ConsoleBuiltinParam("otherwise", "Any")),
					"Any",
					"then when it holds, else otherwise; only the one chosen is read.",
				),
			),
		entities =
			listOf(
				entity(
					"devices",
					"Devices this Gateway holds.",
					property("list", "List<Device>", "Every device, plugs and sensors."),
					method("get", "Device", "One device.", DEVICE),
				),
				entity(
					"sensors",
					"Paired sensors, readings in the owner's unit.",
					property("list", "List<SensorSummary>", "Every sensor, its main reading and when heard."),
					method("read", "Sensor", "Readings now, with 24-hour lows and highs.", DEVICE),
					method("extremes", "Extremes", "One reading's 24-hour low and high.", DEVICE, param("key", "Reading key.", "readings")),
				),
				entity("fields", "Computed fields.", method("read", "Field", "A field's value now.", param("field", "Field id.", "fields"))),
				entity(
					"automations",
					"Automations and what they did.",
					property("runs", "List<Run>", "Recent runs, newest first."),
					method("get", "Automation", "One automation as set.", param("automation", "Automation id.", "automations")),
				),
				entity("sources", "Sources and their health.", method("get", "Source", "One source as set.", param("source", "Source id.", "sources"))),
				entity("definitions", "Device definitions.", method("get", "Definition", "One definition.", param("key", "Definition key.", "definitions"))),
			),
	)

private val SANDBOX_IDS =
	ConsoleIds(
		devices =
			listOf(
				ConsoleDeviceIds("ce:1c:44:06:3c:5d", "Outside thermometer", listOf("temperature", "humidity", "battery")),
				ConsoleDeviceIds("d5:9f:c0:86:0b:32", "My room thermometer", listOf("temperature", "humidity", "battery")),
			),
		fields = emptyList(),
		automations = listOf(ConsoleLabelledId("threshold-ce1c44063c5d-temperature-low", "Outside thermometer temperature below 2.0 °C")),
		sources = listOf(ConsoleLabelledId("github", "GitHub notifications")),
		definitions = listOf("govee-h5110"),
	)

private const val OUTSIDE = """sensors.read("Outside thermometer")"""

private fun sensorJson(at: Long) =
	"""{"name":"Outside thermometer","id":"ce:1c:44:06:3c:5d","radio":"gateway","model":"H5110",
	"heardAt":${at - 4_000},"stale":null,"readings":[
	{"label":"Temperature","key":"temperature","value":64.6,"shown":"64.6 °F",
	"low":{"shown":"58.1 °F","at":${at - 40_000_000}},"high":{"shown":"71.4 °F","at":${at - 9_000_000}}},
	{"label":"Humidity","key":"humidity","value":48.2,"shown":"48.2%"},
	{"label":"Battery","key":"battery","value":100,"shown":"100%"}]}"""

private fun runsJson(at: Long) =
	"""[{"label":"Outside thermometer temperature below 2.0 °C","automation":"a","seq":9,"at":${at - 720_000},"outcome":"ran"},
	{"label":"Random thermometer temperature below 25.0 °C","automation":"b","seq":8,"at":${at - 7_200_000},"outcome":"ran"},
	{"label":"Random thermometer temperature below 25.0 °C","automation":"b","seq":7,"at":${at - 7_300_000},"outcome":"suppressed"}]"""

/** Exact-match answers; no evaluation. */
private fun cannedItem(expr: String, at: Long): ConsoleResultItem? =
	when (expr) {
		OUTSIDE -> ConsoleResultItem(value = Json.parseToJsonElement(sensorJson(at)), type = "Sensor")
		"outside = $OUTSIDE" -> ConsoleResultItem(value = Json.parseToJsonElement(sensorJson(at)), type = "Sensor", assigned = "outside")
		"automations.runs" -> ConsoleResultItem(value = Json.parseToJsonElement(runsJson(at)), type = "List<Run>", cut = ConsoleCut(3, 12))
		"sensors.list.count()" -> ConsoleResultItem(value = Json.parseToJsonElement("2"))
		else -> SANDBOX_DESCRIPTION.entities.firstOrNull { it.name == expr }?.let { ConsoleResultItem(value = JsonNull, entity = it.name) }
	}

internal class SandboxLiveConsoleGateway(
	private val now: () -> Long = System::currentTimeMillis,
	private val pause: suspend () -> Unit = { delay(CONSOLE_ROUND_TRIP_MS) },
) : LiveConsoleGateway {
	private suspend fun <T> answered(gatewayId: String, value: () -> T): ConsoleCall<T> {
		pause()
		return when (gatewayId) {
			SANDBOX_NEVER_REGISTERED -> ConsoleCall.Unreachable
			SECOND_SANDBOX_GATEWAY -> ConsoleCall.Refused(OLDER_GATEWAY)
			else -> ConsoleCall.Answered(value())
		}
	}

	override suspend fun describe(gatewayId: String) =
		answered(gatewayId) { ConsoleDescribeResult(SANDBOX_DESCRIPTION, SANDBOX_HASH) }

	override suspend fun ids(gatewayId: String) = answered(gatewayId) { SANDBOX_IDS }

	override suspend fun eval(gatewayId: String, expr: String, variables: JsonObject?): ConsoleCall<ConsoleEvalResult> =
		answered(gatewayId) {
			val item = cannedItem(expr, now())
			if (item == null) {
				val issue = ConsoleIssue("not_found", 0, expr.length.toLong(), "the sandbox answers only its canned reads")
				ConsoleEvalResult.Error(issue, SANDBOX_HASH)
			} else {
				ConsoleEvalResult.Ok(listOf(item), SANDBOX_HASH)
			}
		}
}
