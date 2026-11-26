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
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionReads
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.StepArg
import kotlinx.serialization.json.JsonObject
import com.atelier_nyaarium.switchboard.assistant.reached
import com.atelier_nyaarium.switchboard.assistant.written
import com.atelier_nyaarium.switchboard.assistant.testLabel
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.liveconsole.HolePart
import com.atelier_nyaarium.switchboard.liveconsole.scanHoles
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationActionOffer
import com.atelier_nyaarium.switchboard.proto.AutomationActionOption
import com.atelier_nyaarium.switchboard.proto.AutomationActionParam
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationHoleSpan
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
		statements = listOf("do", "if", "try", "exit", "throw", "let", "wait", "note", "call"),
		unnamed = true,
	),
	numbers = listOf(
		AutomationNumberOffer(SANDBOX_SENSOR, "temperature", "Outside thermometer temperature", "C", 1L),
		AutomationNumberOffer(SANDBOX_SENSOR, "humidity", "Outside thermometer humidity", "%", 0L),
	),
	switches = listOf(AutomationSwitchOffer(SANDBOX_SWITCH, "Desk lamp")),
)

/** One shelf for both hosts. */
internal val sandboxAutomations by lazy { SandboxAutomationGateway() }

private const val KIND = "kind"

private const val IFTTT = "ifttt_trigger"

private fun fahrenheit(celsius: Double): String = String.format(Locale.ROOT, "%.1f", celsius * 9 / 5 + 32)

/** Root, then member. */
private val NAME_READ = Regex("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)?")

private fun literalOf(arg: JsonElement): JsonElement? =
	(runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), arg) }.getOrNull() as? StepArg.Literal)?.value

/** Names its steps read. */
internal fun sandboxReads(function: AutomationFunction): FunctionReads {
	val names = sortedSetOf<String>()
	val fields = sortedSetOf<String>()
	fun read(source: String) {
		for (match in NAME_READ.findAll(source)) {
			// Member, not root.
			if (match.range.first > 0 && source[match.range.first - 1] == '.') continue
			val root = match.value.substringBefore('.')
			names += root
			if (root == "event" && '.' in match.value) fields += match.value.substringAfter('.')
		}
	}
	for (step in written(function)) {
		val args = (step as? FunctionStep.Do)?.args ?: continue
		for (arg in args.values) {
			when (val held = runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), arg) }.getOrNull()) {
				is StepArg.Expression -> read(held.text)
				is StepArg.Literal -> (held.value as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { text ->
					scanHoles(text).filterIsInstance<HolePart.Hole>().forEach { read(it.source) }
				}
				null -> Unit
			}
		}
	}
	return FunctionReads(names.toList(), fields.toList())
}

private fun inSentence(label: String): String = label.replaceFirstChar { it.lowercase() }

private val SANDBOX_DAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

private fun every(count: Long, unit: String): String = if (count == 1L) "Every $unit" else "Every $count ${unit}s"

/** As a Gateway writes it. */
internal fun sandboxSentence(automation: Automation): String {
	val trigger = when (val held = automation.trigger) {
		is AutomationTrigger.Event -> held
		is AutomationTrigger.Crossing -> {
			return "Outside thermometer temperature goes ${held.direction} ${fahrenheit(held.threshold)} °F"
		}
		is AutomationTrigger.Time -> {
			val days = held.weekdays.sorted()
			val named = if (days.size == 7) "Every day" else days.joinToString(", ") { SANDBOX_DAYS[(it - 1).toInt()] }
			return "$named at ${held.time}"
		}
		is AutomationTrigger.Interval -> return when {
			held.everyMin % 1_440 == 0L -> every(held.everyMin / 1_440, "day")
			held.everyMin % 60 == 0L -> every(held.everyMin / 60, "hour")
			else -> every(held.everyMin, "minute")
		}
		is AutomationTrigger.Value, is AutomationTrigger.Unknown -> return automation.label ?: "Automation"
	}
	val fields = SourceFields(SANDBOX_FIELD_SPECS)
	val said = trigger.conditions.map {
		"${inSentence(fields.fieldLabelOf(it.field))} ${testLabel(it.test)} ${inSentence(fields.valueLabelOf(it.field, it.value))}"
	}
	return "GitHub: ${if (said.isEmpty()) "every event" else said.joinToString(" and ")}"
}

/** The second Gateway refuses as an older build; the empty one lists none. */
internal class SandboxAutomationGateway(
	private val now: () -> Long = System::currentTimeMillis,
	private val pause: suspend () -> Unit = { delay(AUTOMATION_ROUND_TRIP_MS) },
) : AutomationGateway {
	private val shelves = mutableMapOf<String, List<AutomationRow>>()

	private fun github(id: String, field: String, value: String, ranAgoMs: Long?): AutomationRow {
		val automation = Automation(
			enabled = true,
			trigger = AutomationTrigger.Event("github", listOf(AutomationCondition(field, "is", value))),
			actions = listOf(AutomationAction.TellAssistant("now")),
		)
		return AutomationRow(id, 1L, automation, sandboxSentence(automation), lastRanAt = ranAgoMs?.let { now() - it })
	}

	private fun crossing(id: String, direction: String, threshold: Double, enabled: Boolean, ranAgoMs: Long?): AutomationRow {
		val automation = Automation(
			enabled = enabled,
			trigger = AutomationTrigger.Crossing(SANDBOX_SENSOR, "temperature", direction, threshold, 0.5, 600L),
			actions = listOf(AutomationAction.TellAssistant("quietly")),
		)
		return AutomationRow(id, 4L, automation, sandboxSentence(automation), lastRanAt = ranAgoMs?.let { now() - it })
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
			sandboxSentence(automation),
			lastRanAt = now() - 20 * HOUR_MS,
			nextRunAt = now() + 4 * HOUR_MS,
		)
	}

	private fun pointing(id: String, trigger: AutomationTrigger, function: String, values: Map<String, String> = emptyMap()): AutomationRow {
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
		return AutomationRow(id, 1L, automation, sandboxSentence(automation))
	}

	private fun stepArg(arg: StepArg) = wireJson.encodeToJsonElement(StepArg.serializer(), arg)

	private fun step(action: String, vararg args: Pair<String, StepArg>) =
		FunctionStep.Do(action = action, args = JsonObject(args.associate { (name, arg) -> name to stepArg(arg) }))

	/** Revision and body, by id. */
	private val functionShelves = mutableMapOf<String, MutableMap<String, Pair<Long, AutomationFunction>>>()

	private var copies = 0
	private val movedFunctionChecks = mutableSetOf<String>()

	private fun functions(gatewayId: String) = functionShelves.getOrPut(gatewayId) {
		if (gatewayId == EMPTY_GATEWAY) return@getOrPut mutableMapOf()
		mutableMapOf(
			"too-warm" to (2L to AutomationFunction(
				name = "Too warm",
				params = emptyList(),
				steps = listOf(
					step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("quietly")), "message" to StepArg.Literal(JsonPrimitive("It is {value}."))),
					step("device_set", "device" to StepArg.Literal(JsonPrimitive(SANDBOX_SWITCH)), "verb" to StepArg.Literal(JsonPrimitive("on"))),
				),
			)),
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
						steps = listOf(FunctionStep.Wait(StepArg.Literal(JsonPrimitive(5)))),
						catch = listOf(step("tell_assistant", "when" to StepArg.Literal(JsonPrimitive("now")), "message" to StepArg.Literal(JsonPrimitive("The lamp did not answer.")))),
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

	/** A function with no users is unlisted. */
	private fun functionRows(gatewayId: String): List<AutomationFunctionRow> = functions(gatewayId).mapNotNull { (id, held) ->
		val users = shelf(gatewayId).filter { pointerOf(it.automation) == id }
		users.takeIf { it.isNotEmpty() }?.let {
			AutomationFunctionRow(
				id,
				held.first,
				held.second,
				it.map(AutomationRow::id),
				moves = it.any { row -> movesWithHome(row.automation) },
				reads = sandboxReads(held.second),
			)
		}
	}

	private fun shelf(gatewayId: String): List<AutomationRow> = shelves.getOrPut(gatewayId) {
		if (gatewayId == EMPTY_GATEWAY) {
			emptyList()
		} else {
			listOf(
				github("reviews", "reason", "review_requested", 3 * HOUR_MS),
				github("mentions", "reason", "mention", null),
				github("subscribed", "reason", "subscribed", 26 * HOUR_MS),
				github("pulls", "type", "PullRequest", 40 * MINUTE_MS),
				crossing("threshold-ce1c44063c5d-temperature-low", "below", 2.0, enabled = true, ranAgoMs = 26 * HOUR_MS),
				crossing("outside-hot", "above", 30.0, enabled = false, ranAgoMs = null),
				evening(),
				pointing("warm-room", AutomationTrigger.Crossing(SANDBOX_SENSOR, "temperature", "above", 26.0, 0.5, 1_800L), "too-warm"),
				pointing("warm-hall", AutomationTrigger.Crossing(SANDBOX_SENSOR, "temperature", "above", 28.0, 0.5, 1_800L), "too-warm"),
				pointing("blink-evening", AutomationTrigger.Time("19:00", (1L..7L).toList(), "America/Los_Angeles"), "blink", mapOf("lamp" to SANDBOX_SWITCH, "message" to "Good night")),
				pointing("blink-morning", AutomationTrigger.Time("07:00", (1L..7L).toList(), "America/Los_Angeles"), "blink", mapOf("lamp" to SANDBOX_SWITCH, "message" to "Good morning")),
				pointing("lamp-off", AutomationTrigger.Time("23:00", (1L..7L).toList(), "America/Los_Angeles"), SANDBOX_MOVING_FUNCTION),
				pointing("humid", AutomationTrigger.Crossing(SANDBOX_SENSOR, "humidity", "above", 60.0, 2.0, 600L), "fn-humid").copy(
					lastRun = AutomationLastRun(
						at = now() - 2 * HOUR_MS,
						revision = 1L,
						steps = listOf(
							AutomationLastStep("0", "run_function", outcome = "ran"),
							AutomationLastStep("0.0", "if", outcome = "ran", side = "else", function = "fn-humid"),
							AutomationLastStep("0.0.1.0", "tell_assistant", outcome = "ran", function = "fn-humid"),
							AutomationLastStep("0.1", "try", outcome = "ran", function = "fn-humid"),
							AutomationLastStep("0.1.0.0", "wait", outcome = "ran", function = "fn-humid"),
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
			else -> AutomationListing(ListAnswer.Listed(shelf(gatewayId)), SANDBOX_SERVES, functions = functionRows(gatewayId))
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
		) : SaveJudgment
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
		unreadHole(automation)?.let { (span, _) -> return SaveJudgment.Refused(holeRefusal(Protocol.Wire.AutomationSaveRecord.AUTOMATION.wire, span)) }
		landed?.let { (_, body) ->
			unreadStepHole(body.second)?.let {
				return SaveJudgment.Refused(holeRefusal(Protocol.Wire.AutomationSaveRecord.FUNCTION.wire, it))
			}
		}
		if (pointer != null && function != null) {
			val users = listOf(op.automationId to automation) +
				shelf(gatewayId).filter { it.id != op.automationId && pointerOf(it.automation) == pointer }.map { it.id to it.automation }
			val unfit = users.filterNot { (_, body) -> fitsFunction(body, function) }.map { it.first }
			if (unfit.isNotEmpty()) {
				return SaveJudgment.Refused(AutomationSaveRefusal(code = Protocol.Wire.AutomationSaveRefusalCode.UNFIT.wire, automations = unfit))
			}
		}
		val asks = unconfirmed(automation, held, after, stored)
		if (asks.isNotEmpty() && op.confirmed != true) {
			return SaveJudgment.Refused(AutomationSaveRefusal(code = Protocol.Wire.AutomationSaveRefusalCode.CONFIRM.wire, labels = asks))
		}
		return SaveJudgment.Ready(automation, revision, held, landed, copied)
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
			is SaveJudgment.Ready -> ConsoleAutomationCheckResult(ready = true, reads = reads)
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
				val automation = judged.automation
				val revision = judged.revision
				val clocked = automation.trigger is AutomationTrigger.Time || automation.trigger is AutomationTrigger.Interval
				val row = AutomationRow(
					op.automationId,
					revision + 1,
					automation,
					sandboxSentence(automation),
					lastRanAt = judged.held?.lastRanAt,
					nextRunAt = (judged.held?.nextRunAt ?: now() + HOUR_MS).takeIf { clocked && automation.enabled },
				)
				shelves[gatewayId] = if (judged.held == null) shelf(gatewayId) + row else shelf(gatewayId).map { if (it.id == op.automationId) row else it }
				val running = shelf(gatewayId).mapNotNull { pointerOf(it.automation) }.toSet()
				bodies.keys.retainAll(running)
				return ConsoleAutomationSaveResult(stored = true, automation = row, function = functionRows(gatewayId).firstOrNull { it.id == pointerOf(automation) })
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
				is FunctionStep.Try -> return null
				is FunctionStep.Exit -> return null
				is FunctionStep.Throw -> return null
				is FunctionStep.Let -> return null
				is FunctionStep.Wait -> return null
				is FunctionStep.Note -> return null
				is FunctionStep.Call -> return null
				is FunctionStep.Unknown -> return null
			}
			is UnfollowedCall -> return null
		}
		return args.toSortedMap().toString()
	}

	private fun holeRefusal(record: String, span: AutomationHoleSpan) = AutomationSaveRefusal(
		code = "hole",
		record = record,
		path = span.action.toString(),
		param = span.param,
		start = span.start,
		end = span.end,
	)

	/** A hole nothing names. */
	private fun unreadStepHole(function: AutomationFunction): AutomationHoleSpan? {
		val names = SANDBOX_SERVES.triggers.flatMap { it.names }.map { it.name }.toSet() + function.params.map { it.name }
		written(function).forEachIndexed { at, step ->
			val args = (step as? FunctionStep.Do)?.args ?: return@forEachIndexed
			for ((param, arg) in args) {
				val text = (literalOf(arg) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
				val hole = scanHoles(text).filterIsInstance<HolePart.Hole>()
					.firstOrNull { !it.closed || it.source.trim().substringBefore('.') !in names } ?: continue
				return AutomationHoleSpan(at.toLong(), param, hole.start.toLong(), hole.end.toLong())
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
			sandboxSentence(automation),
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
				val hole = scanHoles(text).filterIsInstance<HolePart.Hole>().firstOrNull { !it.closed || it.source.trim() !in names } ?: continue
				return AutomationHoleSpan(at.toLong(), param, hole.start.toLong(), hole.end.toLong()) to "no name ${hole.source.trim()} here"
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
		val parts = text?.let(::scanHoles).orEmpty()
		val unread = parts.filterIsInstance<HolePart.Hole>().firstOrNull { hole ->
			!hole.closed || names.none { it.name == hole.source.trim() }
		}
		val hole = unread?.let { AutomationPreviewHole(it.start.toLong(), it.end.toLong(), "no name ${it.source.trim()} here") }
		val filled = text?.takeIf { hole == null }?.let {
			parts.joinToString("") { part ->
				when (part) {
					is HolePart.Text -> part.text
					is HolePart.Hole -> names.first { it.name == part.source.trim() }.shown
				}
			}
		}
		val wanted = (trigger as? AutomationTrigger.Event)?.conditions.orEmpty().map { it.value.replace('_', ' ') }
		val recent = listOf(
			AutomationPreviewMatch("Review requested: split the pane reader", now() - 3 * HOUR_MS),
			AutomationPreviewMatch("Mention in the release thread", now() - 9 * HOUR_MS),
			AutomationPreviewMatch("Review requested: bump Bun to 1.4.2", now() - 26 * HOUR_MS),
		)
		val matches = recent.filter { match -> wanted.all { match.title.contains(it, ignoreCase = true) } }
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

private val SANDBOX_COMPARE = Regex("""^(\w+)\s*(>|<)\s*(-?\d+(?:\.\d+)?)$""")

/** Booleans and numeric comparisons. */
private fun sandboxCondition(condition: String, names: List<AutomationPreviewName>): AutomationPreviewCondition {
	val typed = condition.trim()
	if (typed == "true" || typed == "false") return AutomationPreviewCondition(holds = typed == "true")
	val compare = SANDBOX_COMPARE.matchEntire(typed)
	val shown = compare?.let { match -> names.find { it.name == match.groupValues[1] }?.shown?.takeWhile { it == '-' || it == '.' || it.isDigit() }?.toDoubleOrNull() }
	if (compare != null && shown != null) {
		val against = compare.groupValues[3].toDouble()
		return AutomationPreviewCondition(holds = if (compare.groupValues[2] == ">") shown > against else shown < against)
	}
	if (names.any { typed.contains(it.name) }) return AutomationPreviewCondition(unread = "it cannot be read now")
	return AutomationPreviewCondition(issue = AutomationConditionIssue(0L, typed.length.toLong(), "no name $typed here"))
}
