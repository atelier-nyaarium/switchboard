package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.SourceFields
import com.atelier_nyaarium.switchboard.assistant.TRIGGER_EVENT
import com.atelier_nyaarium.switchboard.assistant.UnfollowedCall
import com.atelier_nyaarium.switchboard.assistant.WalkAction
import com.atelier_nyaarium.switchboard.assistant.WalkEntry
import com.atelier_nyaarium.switchboard.assistant.WalkStep
import com.atelier_nyaarium.switchboard.assistant.fitOf
import com.atelier_nyaarium.switchboard.assistant.kindOf
import com.atelier_nyaarium.switchboard.assistant.movesWithHome
import com.atelier_nyaarium.switchboard.assistant.pointerOf
import com.atelier_nyaarium.switchboard.assistant.triggerGiven
import kotlinx.serialization.json.JsonElement
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionServes
import com.atelier_nyaarium.switchboard.proto.AutomationSaveFunction
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationCheckResult
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleDescribeResult
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptParseResult
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptPrintResult
import com.atelier_nyaarium.switchboard.proto.ScriptIssue
import com.atelier_nyaarium.switchboard.proto.ScriptStatement
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionReads
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.StepArg
import com.atelier_nyaarium.switchboard.proto.SwitchCase
import kotlinx.serialization.json.JsonObject
import com.atelier_nyaarium.switchboard.assistant.reached
import com.atelier_nyaarium.switchboard.assistant.callsOf
import com.atelier_nyaarium.switchboard.assistant.reachOver
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleStringPart
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleToken
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleTokenKind
import com.atelier_nyaarium.switchboard.liveconsole.everyToken
import com.atelier_nyaarium.switchboard.liveconsole.lexConsole
import com.atelier_nyaarium.switchboard.liveconsole.lexConsoleText
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationActionOffer
import com.atelier_nyaarium.switchboard.proto.AutomationActionOption
import com.atelier_nyaarium.switchboard.proto.AutomationActionParam
import com.atelier_nyaarium.switchboard.assistant.conditionOf
import com.atelier_nyaarium.switchboard.assistant.valuesOf
import com.atelier_nyaarium.switchboard.proto.AutomationConditionServes
import com.atelier_nyaarium.switchboard.proto.FieldTypes
import com.atelier_nyaarium.switchboard.proto.AutomationHoleSpan
import com.atelier_nyaarium.switchboard.proto.AutomationIssue
import com.atelier_nyaarium.switchboard.proto.AutomationNumberOffer
import com.atelier_nyaarium.switchboard.proto.AutomationSwitchOffer
import com.atelier_nyaarium.switchboard.proto.AutomationConditionIssue
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewCondition
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewHole
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewMatch
import com.atelier_nyaarium.switchboard.proto.AutomationPreviewName
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.AutomationTriggerName
import com.atelier_nyaarium.switchboard.proto.AutomationTriggerOffer
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationDeleteResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPutResult
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.util.Locale

private const val AUTOMATION_ROUND_TRIP_MS = 400L
private const val OLDER_GATEWAY = "unknown op automation_put"

private const val SANDBOX_UNFIT = "It does not fit its function."
private const val MINUTE_MS = 60_000L
private const val HOUR_MS = 60 * MINUTE_MS
internal const val SANDBOX_SENSOR = "ce:1c:44:06:3c:5d"
internal const val SANDBOX_SWITCH = "aa:bb:cc:dd:ee:01"

/** Moves on first check. */
internal const val SANDBOX_MOVING_FUNCTION = "night-lamp"

private fun choice(name: String, label: String, vararg options: Pair<String, String>) =
	AutomationActionParam(name, label, "choice", options = options.map { (value, shown) -> AutomationActionOption(value, shown) })

private fun trigger(kind: String, vararg names: Pair<String, String>) =
	AutomationTriggerOffer(kind, names.map { (name, description) -> AutomationTriggerName(name, description) })

/** What the full sandbox Gateway says it holds. */
internal val SANDBOX_SERVES = AutomationServes(
	triggers = listOf(
		trigger("event", "event" to "The event; its fields by name", "source" to "The source's name"),
		trigger("value", "value" to "The value it became", "field" to "The field's name"),
		trigger(
			"crossing",
			"value" to "The reading now",
			"device" to "The device's name",
			"measure" to "What it measures",
			"threshold" to "The threshold",
		),
		trigger("time", "time" to "The time it came round"),
		trigger("interval", "time" to "The time it came round"),
	),
	actions = listOf(
		AutomationActionOffer(
			"tell_assistant",
			"Tell the assistant",
			danger = false,
			home = true,
			params = listOf(
				choice("when", "When", "now" to "Now", "quietly" to "Quietly"),
				AutomationActionParam("message", "Message", "text", max = 1_000L, lines = true, optional = true),
			),
		),
		AutomationActionOffer(
			"device_set",
			"Switch a plug",
			danger = false,
			home = false,
			params = listOf(
				AutomationActionParam("device", "Plug", "switch"),
				choice("verb", "Set", "on" to "On", "off" to "Off", "toggle" to "Toggle"),
			),
		),
		AutomationActionOffer(
			"ifttt_trigger",
			"Send to IFTTT",
			danger = true,
			home = true,
			params = listOf(AutomationActionParam("event", "Event name", "word", max = 80L)) +
				(1..3).map { AutomationActionParam("value$it", "Value $it", "text", max = 500L, optional = true) },
		),
		AutomationActionOffer(
			"run_function",
			"Run a function",
			danger = false,
			home = false,
			params = listOf(
				AutomationActionParam("function", "Function", "function"),
				AutomationActionParam("values", "Values", "values", optional = true),
			),
		),
	),
	functions = AutomationFunctionServes(
		max = Protocol.Wire.FUNCTIONS_MAX.toLong(),
		steps = listOf("tell_assistant", "device_set", "ifttt_trigger"),
		paramTypes = listOf("device", "text", "number"),
		statements = listOf("do", "if", "switch", "try", "exit", "throw", "let", "wait", "note", "unparsed", "call"),
		unnamed = true,
		script = true,
	),
	conditions = AutomationConditionServes(FieldTypes.TEST_LABELS.keys.toList(), Protocol.Wire.CONDITION_VALUES_MAX.toLong()),
	numbers = listOf(
		AutomationNumberOffer(SANDBOX_SENSOR, "temperature", "Outside thermometer temperature", "C", 1L),
		AutomationNumberOffer(SANDBOX_SENSOR, "humidity", "Outside thermometer humidity", "%", 0L),
	),
	switches = listOf(AutomationSwitchOffer(SANDBOX_SWITCH, "Desk lamp")),
)

private const val SANDBOX_SCRIPT = "assistant.tell(\"quietly\", \"It is {value}.\")\ndevices.set(\"Desk lamp\", \"on\")"

private const val SANDBOX_SCRIPT_ONLY = "The emulator reads only its own script."

/** One shelf for both hosts. */
internal val sandboxAutomations by lazy { SandboxAutomationGateway() }

private const val KIND = "kind"

private const val IFTTT = "ifttt_trigger"

private fun fahrenheit(celsius: Double): String = String.format(Locale.ROOT, "%.1f", celsius * 9 / 5 + 32)

private fun literalOf(arg: JsonElement): JsonElement? =
	(runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), arg) }.getOrNull() as? StepArg.Literal)?.value

private fun isDot(token: ConsoleToken?): Boolean = token?.kind == ConsoleTokenKind.PUNCT && token.text == "."

private fun namesRead(tokens: List<ConsoleToken>, names: MutableSet<String>, fields: MutableSet<String>) {
	for ((at, token) in tokens.withIndex()) {
		holesRead(token.parts.orEmpty(), names, fields)
		if (token.kind != ConsoleTokenKind.IDENT || isDot(tokens.getOrNull(at - 1))) continue
		names += token.text
		val member = tokens.getOrNull(at + 2)?.takeIf { isDot(tokens.getOrNull(at + 1)) && it.kind == ConsoleTokenKind.IDENT }
		if (token.text == "event" && member != null) fields += member.text
	}
}

private fun holesOf(text: String): List<ConsoleStringPart.Hole> =
	lexConsoleText(text).filterIsInstance<ConsoleStringPart.Hole>()

private fun ConsoleStringPart.Hole.name(): String? =
	tokens.singleOrNull()?.takeIf { it.kind == ConsoleTokenKind.IDENT }?.text

private fun ConsoleStringPart.Hole.root(): String? =
	tokens.firstOrNull()?.takeIf { it.kind == ConsoleTokenKind.IDENT }?.text

private fun ConsoleStringPart.Hole.written(text: String): String =
	text.substring(start + 1, if (closed) end - 1 else end).trim()

private fun holesRead(parts: List<ConsoleStringPart>, names: MutableSet<String>, fields: MutableSet<String>) {
	for (part in parts) if (part is ConsoleStringPart.Hole) namesRead(part.tokens, names, fields)
}

/** Names its steps read. */
internal fun sandboxReads(function: AutomationFunction): FunctionReads {
	val names = sortedSetOf<String>()
	val fields = sortedSetOf<String>()
	for (step in written(function)) {
		val args = (step as? FunctionStep.Do)?.args ?: continue
		for (arg in args.values) {
			when (val held = runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), arg) }.getOrNull()) {
				is StepArg.Expression -> namesRead(lexConsole(held.text), names, fields)
				is StepArg.Literal -> (held.value as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { text ->
					holesRead(lexConsoleText(text), names, fields)
				}
				null -> Unit
			}
		}
	}
	return FunctionReads(names.toList(), fields.toList())
}

/** A save keeps the held sentence. */
private fun savedSentence(automation: Automation, held: AutomationRow?): String =
	automation.label ?: held?.sentence ?: "Automation"

/** The second Gateway refuses as an older build; the empty one lists none. */
internal class SandboxAutomationGateway(
	private val now: () -> Long = System::currentTimeMillis,
	private val pause: suspend () -> Unit = { delay(AUTOMATION_ROUND_TRIP_MS) },
) : AutomationGateway {
	private val shelves = mutableMapOf<String, List<AutomationRow>>()

	private fun github(id: String, field: String, values: List<String>, ranAgoMs: Long?, sentence: String): AutomationRow {
		val automation = Automation(
			enabled = true,
			trigger = AutomationTrigger.Event("github", listOf(conditionOf(field, "is", values))),
			actions = listOf(AutomationAction.TellAssistant("now")),
		)
		return AutomationRow(id, 1L, automation, sentence, lastRanAt = ranAgoMs?.let { now() - it })
	}

	private fun crossing(id: String, direction: String, threshold: Double, enabled: Boolean, ranAgoMs: Long?, sentence: String): AutomationRow {
		val automation = Automation(
			enabled = enabled,
			trigger = AutomationTrigger.Crossing(SANDBOX_SENSOR, "temperature", direction, threshold, 0.5, 600L),
			actions = listOf(AutomationAction.TellAssistant("quietly")),
		)
		return AutomationRow(id, 4L, automation, sentence, lastRanAt = ranAgoMs?.let { now() - it })
	}

	private fun evening(): AutomationRow {
		val automation = Automation(
			enabled = true,
			trigger = AutomationTrigger.Time("18:00", (1L..7L).toList(), "America/Los_Angeles"),
			actions = listOf(
				AutomationAction.DeviceSet(SANDBOX_SWITCH, "on"),
				AutomationAction.TellAssistant("quietly", "The desk lamp is on. It is {time}."),
			),
		)
		return AutomationRow(
			"evening",
			2L,
			automation,
			"Every day at 18:00",
			lastRanAt = now() - 20 * HOUR_MS,
			nextRunAt = now() + 4 * HOUR_MS,
		)
	}

	private fun pointing(id: String, trigger: AutomationTrigger, function: String, sentence: String, values: Map<String, String> = emptyMap()): AutomationRow {
		val automation = Automation(
			enabled = true,
			trigger = trigger,
			actions = listOf(
				AutomationAction.RunFunction(
					function = function,
					values = values.takeIf { it.isNotEmpty() }?.let { held -> JsonObject(held.mapValues { JsonPrimitive(it.value) }) },
				),
			),
		)
		return AutomationRow(id, 1L, automation, sentence)
	}

	private fun stepArg(arg: StepArg) = wireJson.encodeToJsonElement(StepArg.serializer(), arg)

	private fun step(action: String, vararg args: Pair<String, StepArg>) =
		FunctionStep.Do(action = action, args = JsonObject(args.associate { (name, arg) -> name to stepArg(arg) }))

	/** The seed the canned script reads as. */
	private val tooWarmSteps by lazy {
		listOf(
			step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("quietly")), "message" to StepArg.Literal(JsonPrimitive("It is {value}."))),
			step("device_set", "device" to StepArg.Literal(JsonPrimitive(SANDBOX_SWITCH)), "verb" to StepArg.Literal(JsonPrimitive("on"))),
		)
	}

	/** Revision and body, by id. */
	private val functionShelves = mutableMapOf<String, MutableMap<String, Pair<Long, AutomationFunction>>>()

	private var copies = 0
	private val movedFunctionChecks = mutableSetOf<String>()

	private fun functions(gatewayId: String) = functionShelves.getOrPut(gatewayId) {
		if (gatewayId == EMPTY_GATEWAY) return@getOrPut mutableMapOf()
		mutableMapOf(
			"too-warm" to (2L to AutomationFunction(name = "Too warm", params = emptyList(), steps = tooWarmSteps)),
			"blink" to (1L to AutomationFunction(
				name = "Blink",
				params = listOf(FunctionParam("lamp", "device"), FunctionParam("message", "text")),
				steps = listOf(
					step("device_set", "device" to StepArg.Expression("lamp"), "verb" to StepArg.Literal(JsonPrimitive("toggle"))),
					step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("now")), "message" to StepArg.Literal(JsonPrimitive("{message}"))),
				),
			)),
			"fn-humid" to (1L to AutomationFunction(
				name = "",
				params = emptyList(),
				steps = listOf(
					FunctionStep.If(
						`when` = "value > 60",
						steps = listOf(step("device_set", "device" to StepArg.Literal(JsonPrimitive(SANDBOX_SWITCH)), "verb" to StepArg.Literal(JsonPrimitive("on")))),
						`else` = listOf(step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("quietly")), "message" to StepArg.Literal(JsonPrimitive("Dry enough.")))),
					),
					FunctionStep.Try(
						steps = listOf(step("device_set", "device" to StepArg.Literal(JsonPrimitive(SANDBOX_SWITCH)), "verb" to StepArg.Literal(JsonPrimitive("off")))),
						catch = listOf(step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("now")), "message" to StepArg.Literal(JsonPrimitive("The lamp did not answer.")))),
					),
				),
			)),
			"fn-reason" to (1L to AutomationFunction(
				name = "",
				params = emptyList(),
				steps = listOf(
					FunctionStep.Switch(
						subject = "event.reason",
						cases = listOf(
							SwitchCase(listOf("mention"), listOf(step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("now"))))),
							SwitchCase(
								listOf("review_requested", "assign"),
								listOf(step("device_set", "device" to StepArg.Literal(JsonPrimitive(SANDBOX_SWITCH)), "verb" to StepArg.Literal(JsonPrimitive("on")))),
							),
						),
						default = listOf(
							FunctionStep.If(
								`when` = "event.repository == \"switchboard\"",
								steps = listOf(step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("quietly")))),
								`else` = listOf(
									FunctionStep.If(
										`when` = "event.type == \"Release\"",
										steps = listOf(step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("now")))),
									),
								),
							),
						),
					),
				),
			)),
			SANDBOX_MOVING_FUNCTION to (1L to AutomationFunction(
				name = "Night lamp",
				params = emptyList(),
				steps = listOf(
					step("device_set", "device" to StepArg.Literal(JsonPrimitive(SANDBOX_SWITCH)), "verb" to StepArg.Literal(JsonPrimitive("off"))),
				),
			)),
		)
	}

	/** Unreferenced functions stay unlisted. */
	private fun functionRows(gatewayId: String): List<AutomationFunctionRow> = functions(gatewayId).mapNotNull { (id, held) ->
		val users = shelf(gatewayId).filter { pointerOf(it.automation) == id }
		val callers = functions(gatewayId).filter { (other, body) -> other != id && id in callsOf(body.second) }.keys.toList()
		if (users.isEmpty() && callers.isEmpty()) return@mapNotNull null
		AutomationFunctionRow(
			id,
			held.first,
			held.second,
			users.map(AutomationRow::id),
			moves = users.any { row -> movesWithHome(row.automation) },
			reads = sandboxReads(held.second),
			callers = callers.takeIf { it.isNotEmpty() },
		)
	}

	private fun shelf(gatewayId: String): List<AutomationRow> = shelves.getOrPut(gatewayId) {
		if (gatewayId == EMPTY_GATEWAY) {
			emptyList()
		} else {
			listOf(
				github("reviews", "reason", listOf("review_requested"), 3 * HOUR_MS, "GitHub: reason is review requested"),
				github("mentions", "reason", listOf("mention"), null, "GitHub: reason is mention"),
				github("subscribed", "reason", listOf("subscribed"), 26 * HOUR_MS, "GitHub: reason is subscribed"),
				github("pulls", "type", listOf("PullRequest", "Release"), 40 * MINUTE_MS, "GitHub: type is any of pull request, release"),
				crossing(
					"threshold-ce1c44063c5d-temperature-low",
					"below",
					2.0,
					enabled = true,
					ranAgoMs = 26 * HOUR_MS,
					sentence = "Outside thermometer temperature goes below 35.6 °F",
				),
				crossing("outside-hot", "above", 30.0, enabled = false, ranAgoMs = null, sentence = "Outside thermometer temperature goes above 86.0 °F"),
				evening(),
				pointing(
					"warm-room",
					AutomationTrigger.Crossing(SANDBOX_SENSOR, "temperature", "above", 26.0, 0.5, 1_800L),
					"too-warm",
					"Outside thermometer temperature goes above 78.8 °F",
				).copy(
					lastRun = AutomationLastRun(
						at = now() - HOUR_MS,
						revision = 1L,
						steps = listOf(
							AutomationLastStep("0", "run_function", outcome = Protocol.Wire.RunOutcome.REFUSED.wire, reason = "its function failed", startMs = 0, endMs = 600_000),
							AutomationLastStep("0.0", "tell_assistant", outcome = "ran", function = "too-warm", startMs = 0, endMs = 200),
							AutomationLastStep("0.1", "device_set", outcome = Protocol.Wire.RunOutcome.REFUSED.wire, reason = "it could not be reached", function = "too-warm", startMs = 200, endMs = 600_000),
						),
						running = false,
					),
				),
				pointing(
					"warm-hall",
					AutomationTrigger.Crossing(SANDBOX_SENSOR, "temperature", "above", 28.0, 0.5, 1_800L),
					"too-warm",
					"Outside thermometer temperature goes above 82.4 °F",
				).copy(
					lastRun = AutomationLastRun(
						at = now() - 3 * HOUR_MS,
						revision = 1L,
						steps = listOf(
							AutomationLastStep("0", "run_function", outcome = "ran", startMs = 0, endMs = 900),
							AutomationLastStep("0.0", "tell_assistant", outcome = "ran", function = "too-warm", startMs = 0, endMs = 300),
							AutomationLastStep("0.1", "device_set", outcome = "ran", function = "too-warm", startMs = 300, endMs = 900),
						),
						running = false,
					),
				),
				pointing(
					"blink-evening",
					AutomationTrigger.Time("19:00", (1L..7L).toList(), "America/Los_Angeles"),
					"blink",
					"Every day at 19:00",
					mapOf("lamp" to SANDBOX_SWITCH, "message" to "Good night"),
				).copy(
					lastRun = AutomationLastRun(
						at = now() - 90_000,
						revision = 1L,
						steps = listOf(
							AutomationLastStep("0", "run_function", startMs = 0),
							AutomationLastStep("0.0", "device_set", function = "blink", startMs = 0, retrying = true),
						),
						active = "0.0",
						running = true,
					),
				),
				pointing(
					"blink-morning",
					AutomationTrigger.Time("07:00", (1L..7L).toList(), "America/Los_Angeles"),
					"blink",
					"Every day at 07:00",
					mapOf("lamp" to SANDBOX_SWITCH, "message" to "Good morning"),
				),
				pointing("lamp-off", AutomationTrigger.Time("23:00", (1L..7L).toList(), "America/Los_Angeles"), SANDBOX_MOVING_FUNCTION, "Every day at 23:00"),
				pointing("by-reason", AutomationTrigger.Event("github", emptyList()), "fn-reason", "GitHub: every event").copy(
					lastRun = AutomationLastRun(
						at = now() - 30 * MINUTE_MS,
						revision = 1L,
						steps = listOf(
							AutomationLastStep("0", "run_function", outcome = "ran"),
							AutomationLastStep("0.0", "switch", outcome = "ran", case = 1L, function = "fn-reason"),
							AutomationLastStep("0.0.1.0", "device_set", outcome = "ran", function = "fn-reason"),
						),
						running = false,
					),
				),
				pointing(
					"humid",
					AutomationTrigger.Crossing(SANDBOX_SENSOR, "humidity", "above", 60.0, 2.0, 600L),
					"fn-humid",
					"Outside thermometer humidity goes above 60 %",
				).copy(
					lastRun = AutomationLastRun(
						at = now() - 2 * HOUR_MS,
						revision = 1L,
						steps = listOf(
							AutomationLastStep("0", "run_function", outcome = "ran"),
							AutomationLastStep("0.0", "if", outcome = "ran", side = "else", function = "fn-humid"),
							AutomationLastStep("0.0.1.0", "tell_assistant", outcome = "ran", function = "fn-humid"),
							AutomationLastStep("0.1", "try", outcome = "ran", function = "fn-humid"),
							AutomationLastStep("0.1.0.0", "device_set", outcome = Protocol.Wire.RunOutcome.REFUSED.wire, reason = "it was refused", function = "fn-humid"),
							AutomationLastStep("0.1.1.0", "tell_assistant", outcome = "ran", function = "fn-humid"),
						),
						running = false,
					),
				),
			)
		}
	}

	override suspend fun list(gatewayId: String): AutomationListing {
		pause()
		return when (gatewayId) {
			SANDBOX_NEVER_REGISTERED -> AutomationListing(ListAnswer.Unreachable)
			SECOND_SANDBOX_GATEWAY -> AutomationListing(ListAnswer.NotServed)
			EMPTY_GATEWAY -> AutomationListing(ListAnswer.Listed(shelf(gatewayId)), SANDBOX_SERVES.copy(functions = null))
			else -> AutomationListing(ListAnswer.Listed(shelf(gatewayId).map { withErrors(gatewayId, it) }), SANDBOX_SERVES, functions = functionRows(gatewayId))
		}
	}

	private sealed interface SaveJudgment {
		data class Refused(val refusal: AutomationSaveRefusal) : SaveJudgment

		data class Ready(
			val automation: Automation,
			val revision: Long,
			val held: AutomationRow?,
			val landed: Pair<String, Pair<Long, AutomationFunction>>?,
			val copied: Boolean,
			val issues: List<AutomationIssue>,
		) : SaveJudgment
	}

	private fun spanIssue(record: String, id: String?, span: AutomationHoleSpan, line: String) = AutomationIssue(
		level = Protocol.Wire.AutomationIssueLevel.ERROR.wire,
		record = record,
		id = id,
		step = span.action.toString(),
		param = span.param,
		start = span.start,
		end = span.end,
		line = line,
	)

	/** A copy's id unwritten. */
	private fun issuesOf(automation: Automation, function: Pair<String, AutomationFunction>?, copied: Boolean = false): List<AutomationIssue> = buildList {
		unreadHole(automation)?.let { (span, line) -> add(spanIssue(Protocol.Wire.AutomationSaveRecord.AUTOMATION.wire, null, span, line)) }
		val (id, body) = function ?: return@buildList
		unreadStepHole(body)?.let { (span, line) -> add(spanIssue(Protocol.Wire.AutomationSaveRecord.FUNCTION.wire, id.takeUnless { copied }, span, line)) }
		if (!fitsFunction(automation, body)) {
			add(AutomationIssue(level = Protocol.Wire.AutomationIssueLevel.ERROR.wire, record = Protocol.Wire.AutomationSaveRecord.AUTOMATION.wire, line = SANDBOX_UNFIT))
		}
	}

	private fun withErrors(gatewayId: String, row: AutomationRow): AutomationRow {
		val pointer = pointerOf(row.automation)
		val function = pointer?.let { id -> functions(gatewayId)[id]?.second?.let { id to it } }
		val errors = issuesOf(row.automation, function).count { it.level == Protocol.Wire.AutomationIssueLevel.ERROR.wire }
		return row.copy(errors = errors.toLong().takeIf { it > 0 })
	}

	private fun judge(gatewayId: String, op: ConsoleOp.AutomationSave): SaveJudgment {
		fun refused(code: String, record: String? = null, revision: Long? = null) =
			SaveJudgment.Refused(AutomationSaveRefusal(code = code, record = record, revision = revision))
		val held = shelf(gatewayId).find { it.id == op.automationId }
		val revision = held?.revision ?: 0L
		if (revision != op.automationBase) return refused(Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire, Protocol.Wire.AutomationSaveRecord.AUTOMATION.wire, revision)
		val bodies = functions(gatewayId)
		var automation = op.automation
		var landed: Pair<String, Pair<Long, AutomationFunction>>? = null
		var copied = false
		if (op.function == null && op.functionBase != null) {
			val pointer = pointerOf(automation)
			if (pointer != null) {
				val stored = bodies[pointer]?.first ?: 0L
				if (stored != op.functionBase) {
					return refused(Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire, Protocol.Wire.AutomationSaveRecord.FUNCTION.wire, stored)
				}
			}
		}
		when (val function = op.function) {
			null -> Unit
			is AutomationSaveFunction.Edit -> {
				val stored = bodies[function.id]?.first ?: 0L
				if (stored != function.base) return refused(Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire, Protocol.Wire.AutomationSaveRecord.FUNCTION.wire, stored)
				landed = function.id to (stored + 1 to function.body)
			}
			is AutomationSaveFunction.Copy -> {
				val from = bodies[function.from] ?: return refused(Protocol.Wire.AutomationSaveRefusalCode.GONE.wire, Protocol.Wire.AutomationSaveRecord.FUNCTION.wire)
				if (from.first != function.fromBase) return refused(Protocol.Wire.AutomationSaveRefusalCode.MOVED.wire, Protocol.Wire.AutomationSaveRecord.FUNCTION.wire, from.first)
				val id = "copy-${copies + 1}"
				landed = id to (1L to function.body)
				copied = true
				val pointer = written(automation).singleOrNull() as? AutomationAction.RunFunction ?: AutomationAction.RunFunction(function = id)
				automation = automation.copy(actions = listOf(pointer.copy(function = id)))
			}
		}
		val stored: (String) -> AutomationFunction? = { id -> bodies[id]?.second }
		val after: (String) -> AutomationFunction? = { id -> landed?.takeIf { it.first == id }?.second?.second ?: stored(id) }
		val pointer = pointerOf(automation)
		val function = pointer?.let(after)
		if (pointer != null && function == null) {
			return SaveJudgment.Refused(AutomationSaveRefusal(code = Protocol.Wire.AutomationSaveRefusalCode.UNKNOWN_FUNCTION.wire, id = pointer))
		}
		val asks = unconfirmed(automation, held, after, stored)
		if (asks.isNotEmpty() && op.confirmed != true) {
			return SaveJudgment.Refused(AutomationSaveRefusal(code = Protocol.Wire.AutomationSaveRefusalCode.CONFIRM.wire, labels = asks))
		}
		val issues = issuesOf(automation, pointer?.let { id -> function?.let { id to it } }, copied)
		return SaveJudgment.Ready(automation, revision, held, landed, copied, issues)
	}

	private fun functionFor(gatewayId: String, op: ConsoleOp.AutomationSave): AutomationFunction? {
		val pointer = pointerOf(op.automation) ?: return null
		return when (val function = op.function) {
			is AutomationSaveFunction.Copy -> function.body
			is AutomationSaveFunction.Edit -> if (function.id == pointer) function.body else functions(gatewayId)[pointer]?.second
			null -> functions(gatewayId)[pointer]?.second
		}
	}

	private fun moveFunctionOnFirstCheck(gatewayId: String, op: ConsoleOp.AutomationCheck) {
		if (pointerOf(op.automation) != SANDBOX_MOVING_FUNCTION || gatewayId in movedFunctionChecks) return
		val held = functions(gatewayId)[SANDBOX_MOVING_FUNCTION] ?: return
		val moved = held.second.copy(
			steps = listOf(
				step("device_set", "device" to StepArg.Literal(JsonPrimitive(SANDBOX_SWITCH)), "verb" to StepArg.Literal(JsonPrimitive("off"))),
				step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("quietly")), "message" to StepArg.Literal(JsonPrimitive("Lamp off for the night."))),
			),
		)
		functions(gatewayId)[SANDBOX_MOVING_FUNCTION] = held.first + 1L to moved
		movedFunctionChecks += gatewayId
	}

	private fun saveOf(op: ConsoleOp.AutomationCheck) = ConsoleOp.AutomationSave(
		automationId = op.automationId,
		automation = op.automation,
		automationBase = op.automationBase,
		function = op.function,
		functionBase = op.functionBase,
		confirmed = op.confirmed,
	)

	override suspend fun check(gatewayId: String, op: ConsoleOp.AutomationCheck): ConsoleAutomationCheckResult? {
		pause()
		if (gatewayId == SANDBOX_NEVER_REGISTERED || gatewayId == SECOND_SANDBOX_GATEWAY) return null
		moveFunctionOnFirstCheck(gatewayId, op)
		val save = saveOf(op)
		val reads = functionFor(gatewayId, save)?.let(::sandboxReads)
		return when (val judged = judge(gatewayId, save)) {
			is SaveJudgment.Refused -> ConsoleAutomationCheckResult(ready = false, refusal = judged.refusal, reads = reads)
			is SaveJudgment.Ready -> ConsoleAutomationCheckResult(ready = true, reads = reads, issues = judged.issues.takeIf { it.isNotEmpty() })
		}
	}

	/** Both land, or neither. */
	override suspend fun save(gatewayId: String, op: ConsoleOp.AutomationSave): ConsoleAutomationSaveResult {
		pause()
		when (val judged = judge(gatewayId, op)) {
			is SaveJudgment.Refused -> return ConsoleAutomationSaveResult(stored = false, refusal = judged.refusal)
			is SaveJudgment.Ready -> {
				val bodies = functions(gatewayId)
				judged.landed?.let { (id, body) ->
					if (judged.copied) copies += 1
					bodies[id] = body
				}
				for (called in op.called.orEmpty()) bodies[called.id] = ((bodies[called.id]?.first ?: 0L) + 1L) to called.body
				val automation = judged.automation
				val revision = judged.revision
				val clocked = automation.trigger is AutomationTrigger.Time || automation.trigger is AutomationTrigger.Interval
				val row = AutomationRow(
					op.automationId,
					revision + 1,
					automation,
					savedSentence(automation, judged.held),
					lastRanAt = judged.held?.lastRanAt,
					nextRunAt = (judged.held?.nextRunAt ?: now() + HOUR_MS).takeIf { clocked && automation.enabled },
				)
				shelves[gatewayId] = if (judged.held == null) shelf(gatewayId) + row else shelf(gatewayId).map { if (it.id == op.automationId) row else it }
				val running = shelf(gatewayId).mapNotNull { pointerOf(it.automation) }.toSet()
				bodies.keys.retainAll(reachOver(running) { id -> bodies[id]?.second?.let(::callsOf).orEmpty() })
				return ConsoleAutomationSaveResult(
					stored = true,
					automation = withErrors(gatewayId, row),
					function = functionRows(gatewayId).firstOrNull { it.id == pointerOf(automation) },
					issues = judged.issues.takeIf { it.isNotEmpty() },
				)
			}
		}
	}

	/** IFTTT reach asks. */
	private fun unconfirmed(
		automation: Automation,
		held: AutomationRow?,
		functionOf: (String) -> AutomationFunction?,
		heldFunctionOf: (String) -> AutomationFunction?,
	): List<String> {
		val known = held?.automation?.let { reached(it, heldFunctionOf) }.orEmpty().mapNotNull(::dangerKey).toSet()
		val asks = reached(automation, functionOf).mapNotNull(::dangerKey).any { it !in known }
		return if (asks) listOf("Send to IFTTT") else emptyList()
	}

	/** Keys as flat form. */
	private fun dangerKey(entry: WalkEntry): String? {
		val args = when (entry) {
			is WalkAction ->
				if (kindOf(entry.action) != IFTTT) return null
				else wireJson.encodeToJsonElement(AutomationAction.serializer(), entry.action).jsonObject.filterKeys { it != KIND }
			is WalkStep -> when (val step = entry.step) {
				is FunctionStep.Do -> if (step.action != IFTTT) return null else step.args.mapValues { (_, arg) -> literalOf(arg) ?: arg }
				is FunctionStep.If -> return null
				is FunctionStep.Switch -> return null
				is FunctionStep.Try -> return null
				is FunctionStep.Parallel -> return null
				is FunctionStep.Start -> return null
				is FunctionStep.Await -> return null
				is FunctionStep.Exit -> return null
				is FunctionStep.Throw -> return null
				is FunctionStep.Let -> return null
				is FunctionStep.Wait -> return null
				is FunctionStep.Note -> return null
				is FunctionStep.Unparsed -> return null
				is FunctionStep.Call -> return null
				is FunctionStep.Unknown -> return null
			}
			is UnfollowedCall -> return null
		}
		return args.toSortedMap().toString()
	}

	/** A hole nothing names. */
	private fun unreadStepHole(function: AutomationFunction): Pair<AutomationHoleSpan, String>? {
		val names = SANDBOX_SERVES.triggers.flatMap { it.names }.map { it.name }.toSet() + function.params.map { it.name }
		written(function).forEachIndexed { at, step ->
			val args = (step as? FunctionStep.Do)?.args ?: return@forEachIndexed
			for ((param, arg) in args) {
				val text = (literalOf(arg) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
				val hole = holesOf(text).firstOrNull { !it.closed || it.root() !in names } ?: continue
				return AutomationHoleSpan(at.toLong(), param, hole.start.toLong(), hole.end.toLong()) to "no name ${hole.written(text)} here"
			}
		}
		return null
	}

	/** Trigger fills function. */
	private fun fitsFunction(automation: Automation, function: AutomationFunction): Boolean {
		val pointer = written(automation).singleOrNull() as? AutomationAction.RunFunction ?: return true
		val kind = (wireJson.encodeToJsonElement(AutomationTrigger.serializer(), automation.trigger).jsonObject[KIND] as? JsonPrimitive)?.content.orEmpty()
		val events = SourceFields(SANDBOX_FIELD_SPECS).fields.takeIf { kind == TRIGGER_EVENT }
		val values = pointer.values.orEmpty().mapNotNull { (name, value) -> (value as? JsonPrimitive)?.let { name to it } }.toMap()
		val given = triggerGiven(kind, eventFields = events)
		if (!fitOf(given, function.params, sandboxReads(function), values).fits) return false
		val fromTrigger = given.names.map { it.name }.toSet()
		return function.params.filter { it.type == "device" && it.name !in fromTrigger }.all { param ->
			val device = values[param.name]?.contentOrNull ?: return@all false
			SANDBOX_SERVES.switches.any { it.device == device }
		}
	}

	override suspend fun put(
		gatewayId: String,
		automationId: String,
		automation: Automation,
		baseRevision: Long,
		confirmed: Boolean,
	): ConsoleAutomationPutResult {
		pause()
		if (gatewayId == SECOND_SANDBOX_GATEWAY) return ConsoleAutomationPutResult(stored = false, revision = 0L, reason = OLDER_GATEWAY)
		val held = shelf(gatewayId).find { it.id == automationId }
		val revision = held?.revision ?: 0L
		if (revision != baseRevision) return ConsoleAutomationPutResult(false, revision, held, "revision $revision is stored")
		val stored: (String) -> AutomationFunction? = { id -> functions(gatewayId)[id]?.second }
		val asks = unconfirmed(automation, held, stored, stored)
		if (asks.isNotEmpty() && !confirmed) {
			return ConsoleAutomationPutResult(false, revision, held, "confirm what it does without asking", confirm = asks)
		}
		unreadHole(automation)?.let { (span, reason) -> return ConsoleAutomationPutResult(false, revision, held, reason, hole = span) }
		val clocked = automation.trigger is AutomationTrigger.Time || automation.trigger is AutomationTrigger.Interval
		val row = AutomationRow(
			automationId,
			revision + 1,
			automation,
			savedSentence(automation, held),
			lastRanAt = held?.lastRanAt,
			nextRunAt = (held?.nextRunAt ?: now() + HOUR_MS).takeIf { clocked && automation.enabled },
		)
		shelves[gatewayId] = if (held == null) shelf(gatewayId) + row else shelf(gatewayId).map { if (it.id == automationId) row else it }
		return ConsoleAutomationPutResult(true, row.revision, row)
	}

	override suspend fun delete(gatewayId: String, automationId: String, baseRevision: Long): ConsoleAutomationDeleteResult {
		pause()
		val held = shelf(gatewayId).find { it.id == automationId } ?: return ConsoleAutomationDeleteResult(false, "not stored")
		if (held.revision != baseRevision) return ConsoleAutomationDeleteResult(false, "revision ${held.revision} is stored")
		shelves[gatewayId] = shelf(gatewayId) - held
		val running = shelf(gatewayId).mapNotNull { pointerOf(it.automation) }.toSet()
		functions(gatewayId).keys.retainAll(running)
		return ConsoleAutomationDeleteResult(true)
	}

	/** Seed's canned script. */
	private fun cannedScript(gatewayId: String): Pair<List<FunctionStep>, String>? =
		(tooWarmSteps to SANDBOX_SCRIPT).takeIf { gatewayId != EMPTY_GATEWAY }

	private fun statementsOf(text: String): List<ScriptStatement> {
		var start = 0
		return text.split("\n").mapIndexed { at, line -> ScriptStatement("$at", start.toLong(), (start + line.length).toLong()).also { start += line.length + 1 } }
	}

	override suspend fun scriptPrint(gatewayId: String, op: ConsoleOp.ScriptPrint): ConsoleScriptPrintResult? {
		pause()
		if (gatewayId == SANDBOX_NEVER_REGISTERED) return null
		val canned = cannedScript(gatewayId)
		if (canned == null || canned.first != op.steps) {
			return ConsoleScriptPrintResult("", readOnly = SANDBOX_SCRIPT_ONLY, names = emptyList(), types = emptyList(), statements = emptyList())
		}
		return ConsoleScriptPrintResult(canned.second, names = emptyList(), types = emptyList(), statements = statementsOf(canned.second))
	}

	override suspend fun scriptParse(gatewayId: String, op: ConsoleOp.ScriptParse): ConsoleScriptParseResult? {
		pause()
		if (gatewayId == SANDBOX_NEVER_REGISTERED) return null
		val canned = cannedScript(gatewayId)
		if (canned == null || canned.second != op.text) {
			val issue = ScriptIssue(0L, minOf(1, op.text.length).toLong(), SANDBOX_SCRIPT_ONLY)
			return ConsoleScriptParseResult(issues = listOf(issue), names = emptyList(), types = emptyList(), statements = emptyList())
		}
		return ConsoleScriptParseResult(steps = canned.first, names = emptyList(), types = emptyList(), statements = statementsOf(canned.second))
	}

	override suspend fun scriptVocabulary(gatewayId: String): ConsoleDescribeResult? {
		pause()
		return ConsoleDescribeResult(SANDBOX_DESCRIPTION, SANDBOX_HASH)
	}

	override suspend fun run(gatewayId: String, automationId: String, callId: String): AutomationRan {
		pause()
		if (gatewayId == SECOND_SANDBOX_GATEWAY) return AutomationRan.NotServed
		if (gatewayId == SANDBOX_NEVER_REGISTERED) return AutomationRan.Unreachable
		val held = shelf(gatewayId).find { it.id == automationId }
			?: return AutomationRan.Refused(Protocol.Wire.AutomationRunRefusal.GONE)
		if (!held.automation.enabled) return AutomationRan.Refused(Protocol.Wire.AutomationRunRefusal.OFF)
		val steps = written(held.automation).indices.map { AutomationLastStep("$it", "action", outcome = Protocol.Wire.RunOutcome.RAN.wire) }
		val ran = held.copy(lastRanAt = now(), lastRun = AutomationLastRun(now(), held.revision, steps, running = false))
		shelves[gatewayId] = shelf(gatewayId).map { if (it.id == automationId) ran else it }
		return AutomationRan.Started
	}

	/** The names each kind of trigger offers a text. */
	private fun namesOf(trigger: AutomationTrigger): List<AutomationPreviewName> = when (trigger) {
		is AutomationTrigger.Event -> listOf(
			AutomationPreviewName("event", "Review requested: split the pane reader"),
			AutomationPreviewName("source", "GitHub notifications"),
		)
		is AutomationTrigger.Crossing -> listOf(
			AutomationPreviewName("value", "${fahrenheit(1.8)} °F"),
			AutomationPreviewName("device", "Outside thermometer"),
			AutomationPreviewName("measure", "Temperature"),
			AutomationPreviewName("threshold", "${trigger.threshold} °C"),
		)
		is AutomationTrigger.Time, is AutomationTrigger.Interval -> listOf(AutomationPreviewName("time", "18:00"))
		is AutomationTrigger.Value, is AutomationTrigger.Unknown -> emptyList()
	}

	/** The first hole that is not one of the trigger's names. */
	private fun unreadHole(automation: Automation): Pair<AutomationHoleSpan, String>? {
		val names = namesOf(automation.trigger).map { it.name }
		written(automation).forEachIndexed { at, action ->
			for ((param, held) in wireJson.encodeToJsonElement(AutomationAction.serializer(), action).jsonObject) {
				val text = (held as? JsonPrimitive)?.takeIf { it.isString && param != "kind" }?.content ?: continue
				val hole = holesOf(text).firstOrNull { !it.closed || it.name() !in names } ?: continue
				return AutomationHoleSpan(at.toLong(), param, hole.start.toLong(), hole.end.toLong()) to "no name ${hole.written(text)} here"
			}
		}
		return null
	}

	/** Matches titles by each value; a text fills only a hole that is one name. */
	override suspend fun preview(gatewayId: String, ask: ConsoleOp.AutomationPreview): ConsoleAutomationPreviewResult? {
		val trigger = ask.trigger
		val text = ask.text
		val params = ask.params
		val values = ask.values
		pause()
		if (gatewayId == SANDBOX_NEVER_REGISTERED || gatewayId == SECOND_SANDBOX_GATEWAY) return null
		val names = namesOf(trigger) + params.orEmpty().map { param ->
			val value = (values?.get(param.name) as? JsonPrimitive)?.contentOrNull.orEmpty()
			val shown = if (param.type == "device") SANDBOX_SERVES.switches.find { it.device == value }?.name ?: value else value
			AutomationPreviewName(param.name, shown)
		}
		val parts = text?.let(::lexConsoleText).orEmpty()
		val unread = parts.filterIsInstance<ConsoleStringPart.Hole>().firstOrNull { hole ->
			!hole.closed || names.none { it.name == hole.name() }
		}
		val hole = unread?.let {
			AutomationPreviewHole(it.start.toLong(), it.end.toLong(), "no name ${it.written(text.orEmpty())} here")
		}
		val filled = text?.takeIf { hole == null }?.let {
			parts.joinToString("") { part ->
				when (part) {
					is ConsoleStringPart.Text -> part.value
					is ConsoleStringPart.Escape -> part.value
					is ConsoleStringPart.Hole -> names.first { it.name == part.name() }.shown
				}
			}
		}
		val wanted = (trigger as? AutomationTrigger.Event)?.conditions.orEmpty().map { condition -> valuesOf(condition).map { it.replace('_', ' ') } }
		val recent = listOf(
			AutomationPreviewMatch("Review requested: split the pane reader", now() - 3 * HOUR_MS),
			AutomationPreviewMatch("Mention in the release thread", now() - 9 * HOUR_MS),
			AutomationPreviewMatch("Review requested: bump Bun to 1.4.2", now() - 26 * HOUR_MS),
		)
		val matches = recent.filter { match -> wanted.all { any -> any.isEmpty() || any.any { match.title.contains(it, ignoreCase = true) } } }
		val event = trigger is AutomationTrigger.Event
		return ConsoleAutomationPreviewResult(
			matched = if (event) matches.size.toLong() else 0L,
			of = if (event) 50L else 0L,
			matches = if (event) matches else emptyList(),
			names = names,
			filled = filled,
			hole = hole,
			condition = ask.condition?.let { sandboxCondition(it, names) },
		)
	}
}

private data class SandboxCompare(val name: String, val operator: String, val number: Double)

private fun sandboxCompare(source: String): SandboxCompare? {
	val tokens = lexConsole(source)
	val name = tokens.getOrNull(0)?.takeIf { it.kind == ConsoleTokenKind.IDENT } ?: return null
	val operator = tokens.getOrNull(1)?.takeIf { it.kind == ConsoleTokenKind.OP && (it.text == ">" || it.text == "<") } ?: return null
	val rest = tokens.drop(2)
	val negative = rest.size == 2 && rest[0].kind == ConsoleTokenKind.OP && rest[0].text == "-"
	if (rest.size != if (negative) 2 else 1) return null
	val number = rest.last().takeIf { it.kind == ConsoleTokenKind.NUMBER }?.text?.toDoubleOrNull() ?: return null
	return SandboxCompare(name.text, operator.text, if (negative) -number else number)
}

/** Booleans and numeric comparisons. */
private fun sandboxCondition(condition: String, names: List<AutomationPreviewName>): AutomationPreviewCondition {
	val tokens = lexConsole(condition)
	val constant = tokens.singleOrNull()?.takeIf { it.kind == ConsoleTokenKind.KEYWORD && it.text != "null" }
	if (constant != null) return AutomationPreviewCondition(holds = constant.text == "true")
	val compare = sandboxCompare(condition)
	val shown = compare?.let { match -> names.find { it.name == match.name }?.shown?.takeWhile { it == '-' || it == '.' || it.isDigit() }?.toDoubleOrNull() }
	if (compare != null && shown != null) {
		return AutomationPreviewCondition(holds = if (compare.operator == ">") shown > compare.number else shown < compare.number)
	}
	val read = everyToken(tokens).filter { it.kind == ConsoleTokenKind.IDENT }
	if (read.any { token -> names.any { it.name == token.text } }) {
		return AutomationPreviewCondition(unread = "it cannot be read now")
	}
	val unknown = read.firstOrNull()
	val start = unknown?.start ?: 0
	val end = unknown?.end ?: condition.length
	return AutomationPreviewCondition(
		issue = AutomationConditionIssue(start.toLong(), end.toLong(), "no name ${unknown?.text ?: condition.trim()} here"),
	)
}
