package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.assistant.SourceFields
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
import kotlinx.serialization.json.jsonObject

private const val AUTOMATION_ROUND_TRIP_MS = 400L
private const val OLDER_GATEWAY = "unknown op automation_put"
private const val MINUTE_MS = 60_000L
private const val HOUR_MS = 60 * MINUTE_MS
internal const val SANDBOX_SENSOR = "ce:1c:44:06:3c:5d"
internal const val SANDBOX_SWITCH = "aa:bb:cc:dd:ee:01"

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
	),
	numbers = listOf(
		AutomationNumberOffer(SANDBOX_SENSOR, "temperature", "Outside thermometer temperature", "C", 1L),
		AutomationNumberOffer(SANDBOX_SENSOR, "humidity", "Outside thermometer humidity", "%", 0L),
	),
	switches = listOf(AutomationSwitchOffer(SANDBOX_SWITCH, "Desk lamp")),
)

/** One shelf for both hosts. */
internal val sandboxAutomations by lazy { SandboxAutomationGateway() }

private fun inSentence(label: String): String = label.replaceFirstChar { it.lowercase() }

private val SANDBOX_DAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

private fun every(count: Long, unit: String): String = if (count == 1L) "Every $unit" else "Every $count ${unit}s"

/** As a Gateway writes it. */
internal fun sandboxSentence(automation: Automation): String {
	val trigger = when (val held = automation.trigger) {
		is AutomationTrigger.Event -> held
		is AutomationTrigger.Crossing ->
			return "Outside thermometer temperature goes ${held.direction} ${held.threshold} °C"
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
			)
		}
	}

	override suspend fun list(gatewayId: String): AutomationListing {
		pause()
		return when (gatewayId) {
			SANDBOX_NEVER_REGISTERED -> AutomationListing(ListAnswer.Unreachable)
			SECOND_SANDBOX_GATEWAY -> AutomationListing(ListAnswer.NotServed)
			else -> AutomationListing(ListAnswer.Listed(shelf(gatewayId)), SANDBOX_SERVES)
		}
	}

	/** An IFTTT action the held row lacks asks first. */
	private fun unconfirmed(automation: Automation, held: AutomationRow?): List<String> {
		val known = held?.automation?.let(::reached).orEmpty().map { it.action }.filterIsInstance<AutomationAction.IftttTrigger>().toSet()
		val asks = reached(automation).map { it.action }.filterIsInstance<AutomationAction.IftttTrigger>().any { it !in known }
		return if (asks) listOf("Send to IFTTT") else emptyList()
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
		val asks = unconfirmed(automation, held)
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
		return ConsoleAutomationDeleteResult(true)
	}

	/** The names each kind of trigger offers a text. */
	private fun namesOf(trigger: AutomationTrigger): List<AutomationPreviewName> = when (trigger) {
		is AutomationTrigger.Event -> listOf(
			AutomationPreviewName("event", "Review requested: split the pane reader"),
			AutomationPreviewName("source", "GitHub notifications"),
		)
		is AutomationTrigger.Crossing -> listOf(
			AutomationPreviewName("value", "1.8 °C"),
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
	override suspend fun preview(gatewayId: String, trigger: AutomationTrigger, text: String?): ConsoleAutomationPreviewResult? {
		pause()
		if (gatewayId == SANDBOX_NEVER_REGISTERED || gatewayId == SECOND_SANDBOX_GATEWAY) return null
		val names = namesOf(trigger)
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
		)
	}
}
