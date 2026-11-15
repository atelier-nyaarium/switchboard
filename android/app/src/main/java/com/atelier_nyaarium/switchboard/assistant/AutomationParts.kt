package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.GatewayEntry
import com.atelier_nyaarium.switchboard.displayedUnit
import com.atelier_nyaarium.switchboard.formatDecimal
import com.atelier_nyaarium.switchboard.fromDisplay
import com.atelier_nyaarium.switchboard.liveconsole.HolePart
import com.atelier_nyaarium.switchboard.liveconsole.scanHoles
import com.atelier_nyaarium.switchboard.parseDecimal
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.FieldTypes
import com.atelier_nyaarium.switchboard.roundTo
import com.atelier_nyaarium.switchboard.suffixOf
import com.atelier_nyaarium.switchboard.toDisplay

internal const val TRIGGER_EVENT = "event"
internal const val TRIGGER_CROSSING = "crossing"
internal const val TRIGGER_TIME = "time"
internal const val TRIGGER_INTERVAL = "interval"
internal const val ACTION_TELL = "tell_assistant"
internal const val ACTION_DEVICE_SET = "device_set"
internal const val ACTION_IFTTT = "ifttt_trigger"

internal const val MAX_ACTIONS = 8
internal const val MAX_MESSAGE_LEN = 1_000
internal const val MAX_IFTTT_VALUE_LEN = 500
private const val MAX_COOL_DOWN_MIN = 1_440L
private const val MAX_INTERVAL_MIN = 10_080L
private val CLOCK = Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$")
private val IFTTT_EVENT = Regex("^[A-Za-z0-9_-]{1,80}$")

internal data class ActionOffer(val kind: String, val label: String, val danger: Boolean)

/** A sensor's number a crossing can watch. */
internal data class NumberOffer(val device: String, val measure: String, val label: String, val unit: String?, val decimals: Int)

internal data class SwitchOffer(val device: String, val name: String)

/** What one Gateway's editor may hold. */
internal data class AutomationOffer(
	val triggers: Set<String> = setOf(TRIGGER_EVENT),
	val actions: List<ActionOffer> = listOf(ActionOffer(ACTION_TELL, "Tell the assistant", false)),
	val numbers: List<NumberOffer> = emptyList(),
	val switches: List<SwitchOffer> = emptyList(),
	/** Not the home: no events, tells or IFTTT key. */
	val away: Boolean = false,
) {
	fun number(device: String, measure: String): NumberOffer? = numbers.find { it.device == device && it.measure == measure }

	fun dangerous(kind: String): Boolean = actions.any { it.kind == kind && it.danger }

	fun labelOf(kind: String): String = actions.find { it.kind == kind }?.label ?: kind
}

/** A Gateway that names no kinds holds an event and a tell. */
internal fun offerOf(serves: AutomationServes?, away: Boolean = false): AutomationOffer =
	if (serves == null) AutomationOffer(away = away)
	else AutomationOffer(
		triggers = serves.triggers.toSet(),
		actions = serves.actions.map { ActionOffer(it.kind, it.label, it.danger) },
		numbers = serves.numbers.map { NumberOffer(it.device, it.measure, it.label, it.unit, it.decimals.toInt()) },
		switches = serves.switches.map { SwitchOffer(it.device, it.name) },
		away = away,
	)

/** What an entry's last listing said it holds. */
internal fun offerOn(entry: GatewayEntry?, away: Boolean = false): AutomationOffer = offerOf(entry?.automationServes, away)

/** Leaves and arrives with the assistant. */
internal fun movesWithHome(automation: Automation): Boolean = automation.trigger is AutomationTrigger.Event

internal enum class IntervalUnit(val minutes: Long, val label: String) {
	MINUTES(1, "minutes"),
	HOURS(60, "hours"),
	DAYS(1_440, "days"),
}

/** A trigger as the editor holds it: numbers as typed, in the owner's unit. */
internal sealed interface TriggerDraft {
	val kind: String

	data class Event(val source: String, val conditions: List<AutomationCondition>) : TriggerDraft {
		override val kind get() = TRIGGER_EVENT
	}

	data class Crossing(
		val device: String,
		val measure: String,
		val direction: String,
		val threshold: String,
		val deadZone: String,
		val coolDownMin: String,
	) : TriggerDraft {
		override val kind get() = TRIGGER_CROSSING
	}

	data class Time(val time: String, val weekdays: Set<Int>, val zone: String) : TriggerDraft {
		override val kind get() = TRIGGER_TIME
	}

	data class Interval(val every: String, val unit: IntervalUnit) : TriggerDraft {
		override val kind get() = TRIGGER_INTERVAL
	}
}

/** The editor's three choices; a time and an interval share one. */
internal enum class TriggerChoice(val label: String, val kinds: Set<String>) {
	EVENT("Event arrives", setOf(TRIGGER_EVENT)),
	CROSSING("Value crosses", setOf(TRIGGER_CROSSING)),
	TIME("Time comes", setOf(TRIGGER_TIME, TRIGGER_INTERVAL)),
}

internal fun choiceOf(trigger: TriggerDraft): TriggerChoice = TriggerChoice.entries.first { trigger.kind in it.kinds }

internal fun offersChoice(offer: AutomationOffer, choice: TriggerChoice, sources: Boolean): Boolean = when (choice) {
	TriggerChoice.EVENT -> TRIGGER_EVENT in offer.triggers && sources && !offer.away
	TriggerChoice.CROSSING -> TRIGGER_CROSSING in offer.triggers && offer.numbers.isNotEmpty()
	TriggerChoice.TIME -> offer.triggers.any { it in choice.kinds }
}

/** The clock kinds a Gateway holds, a time first. */
internal fun clockKinds(offer: AutomationOffer): List<String> = listOf(TRIGGER_TIME, TRIGGER_INTERVAL).filter { it in offer.triggers }

/** A number's unit as the owner reads it. */
internal fun numberSuffix(number: NumberOffer?, display: String?): String =
	number?.unit?.let { suffixOf(displayedUnit(it, display)) }.orEmpty()

private fun scaleOf(unit: String?, display: String?): Double =
	FieldTypes.UNIT_DISPLAYS.find { it.unit == unit && it.display == display }?.scale ?: 1.0

/** A stored number as the owner types it. */
private fun typedOf(value: Double, number: NumberOffer?, display: String?): String {
	val unit = number?.unit
	val shown = if (unit != null && display != null) toDisplay(value, unit, display).value else value
	return formatDecimal(shown, number?.decimals ?: 1)
}

/** A width scales without the unit's offset. */
private fun typedWidthOf(value: Double, number: NumberOffer?, display: String?): String =
	formatDecimal(value * scaleOf(number?.unit, display), number?.decimals ?: 1)

/** Null for a kind the editor does not draw. */
internal fun triggerDraftOf(trigger: AutomationTrigger, offer: AutomationOffer, display: String?): TriggerDraft? = when (trigger) {
	is AutomationTrigger.Event -> TriggerDraft.Event(trigger.source, trigger.conditions)
	is AutomationTrigger.Crossing -> {
		val number = offer.number(trigger.device, trigger.measure)
		TriggerDraft.Crossing(
			device = trigger.device,
			measure = trigger.measure,
			direction = trigger.direction,
			threshold = typedOf(trigger.threshold, number, display),
			deadZone = typedWidthOf(trigger.deadZone, number, display),
			coolDownMin = (trigger.coolDownSec / 60).toString(),
		)
	}
	is AutomationTrigger.Time -> TriggerDraft.Time(trigger.time, trigger.weekdays.map { it.toInt() }.toSet(), trigger.zone)
	is AutomationTrigger.Interval -> {
		val unit = IntervalUnit.entries.last { trigger.everyMin % it.minutes == 0L }
		TriggerDraft.Interval((trigger.everyMin / unit.minutes).toString(), unit)
	}
	is AutomationTrigger.Value, is AutomationTrigger.Unknown -> null
}

/** Why a typed trigger cannot be saved; null when it can. */
internal fun triggerIssue(trigger: TriggerDraft, offer: AutomationOffer): String? = when (trigger) {
	is TriggerDraft.Event -> when {
		trigger.source.isBlank() -> "Pick a source"
		trigger.conditions.size > MAX_CONDITIONS -> "Too many conditions"
		else -> null
	}
	is TriggerDraft.Crossing -> when {
		offer.number(trigger.device, trigger.measure) == null -> "Pick a value"
		parseDecimal(trigger.threshold.trim()) == null -> "The threshold is not a number"
		(parseDecimal(trigger.deadZone.trim()) ?: -1.0) < 0 -> "The dead zone is zero or more"
		(trigger.coolDownMin.trim().toLongOrNull() ?: -1L) !in 0..MAX_COOL_DOWN_MIN -> "The cool-down is 0 to $MAX_COOL_DOWN_MIN minutes"
		else -> null
	}
	is TriggerDraft.Time -> when {
		!CLOCK.matches(trigger.time) -> "Pick a time"
		trigger.weekdays.isEmpty() -> "Pick a day"
		trigger.zone.isBlank() -> "No time zone"
		else -> null
	}
	is TriggerDraft.Interval -> {
		val minutes = (trigger.every.trim().toLongOrNull() ?: 0L) * trigger.unit.minutes
		if (minutes in 1..MAX_INTERVAL_MIN) null else "From 1 minute to 7 days"
	}
}

/** Silent about a field that is still blank; its other fields still say. */
internal fun triggerHint(trigger: TriggerDraft, offer: AutomationOffer): String? = when (trigger) {
	is TriggerDraft.Crossing -> triggerIssue(if (trigger.threshold.isBlank()) trigger.copy(threshold = "0") else trigger, offer)
	is TriggerDraft.Interval -> if (trigger.every.isBlank()) null else triggerIssue(trigger, offer)
	is TriggerDraft.Event, is TriggerDraft.Time -> triggerIssue(trigger, offer)
}

/** Null while `triggerIssue` names a reason. */
internal fun triggerOf(trigger: TriggerDraft, offer: AutomationOffer, display: String?): AutomationTrigger? {
	if (triggerIssue(trigger, offer) != null) return null
	return when (trigger) {
		is TriggerDraft.Event -> AutomationTrigger.Event(
			source = trigger.source,
			conditions = trigger.conditions.map { it.copy(value = trimRuleValue(it.value)) },
		)
		is TriggerDraft.Crossing -> {
			val number = offer.number(trigger.device, trigger.measure) ?: return null
			val typed = parseDecimal(trigger.threshold.trim()) ?: return null
			val width = parseDecimal(trigger.deadZone.trim()) ?: return null
			val unit = number.unit
			AutomationTrigger.Crossing(
				device = trigger.device,
				measure = trigger.measure,
				direction = trigger.direction,
				threshold = if (unit != null && display != null) fromDisplay(typed, unit, display) else typed,
				deadZone = roundTo(width / scaleOf(unit, display), FieldTypes.CONVERTED_DECIMALS),
				coolDownSec = (trigger.coolDownMin.trim().toLongOrNull() ?: return null) * 60,
			)
		}
		is TriggerDraft.Time -> AutomationTrigger.Time(trigger.time, trigger.weekdays.sorted().map { it.toLong() }, trigger.zone)
		is TriggerDraft.Interval -> AutomationTrigger.Interval((trigger.every.trim().toLongOrNull() ?: return null) * trigger.unit.minutes)
	}
}

/** What a choice starts as; null when this Gateway cannot hold it. */
internal fun freshTrigger(choice: TriggerChoice, offer: AutomationOffer, firstSource: String?, zone: String): TriggerDraft? = when (choice) {
	TriggerChoice.EVENT -> firstSource?.let { TriggerDraft.Event(it, emptyList()) }
	TriggerChoice.CROSSING -> offer.numbers.firstOrNull()?.let {
		TriggerDraft.Crossing(it.device, it.measure, "below", "", "0.5", "10")
	}
	TriggerChoice.TIME -> clockKinds(offer).firstNotNullOfOrNull { freshClock(it, zone) }
}

/** An action as the editor holds it. */
internal sealed interface ActionDraft {
	val kind: String

	data class Tell(val told: String, val message: String) : ActionDraft {
		override val kind get() = ACTION_TELL
	}

	data class DeviceSet(val device: String, val verb: String) : ActionDraft {
		override val kind get() = ACTION_DEVICE_SET
	}

	data class Ifttt(val event: String, val value1: String, val value2: String, val value3: String) : ActionDraft {
		override val kind get() = ACTION_IFTTT
	}

	/** A kind this build cannot draw, kept as sent. */
	data class Kept(val action: AutomationAction.Unknown) : ActionDraft {
		override val kind get() = action.kind
	}
}

internal fun actionDraftOf(action: AutomationAction): ActionDraft = when (action) {
	is AutomationAction.TellAssistant -> ActionDraft.Tell(action.`when`, action.message.orEmpty())
	is AutomationAction.DeviceSet -> ActionDraft.DeviceSet(action.device, action.verb)
	is AutomationAction.IftttTrigger ->
		ActionDraft.Ifttt(action.event, action.value1.orEmpty(), action.value2.orEmpty(), action.value3.orEmpty())
	is AutomationAction.Unknown -> ActionDraft.Kept(action)
}

internal fun actionIssue(action: ActionDraft, offer: AutomationOffer): String? = when (action) {
	is ActionDraft.Tell -> "At most $MAX_MESSAGE_LEN characters".takeIf { action.message.length > MAX_MESSAGE_LEN }
	is ActionDraft.DeviceSet -> "Pick a plug".takeIf { offer.switches.none { it.device == action.device } }
	is ActionDraft.Ifttt -> when {
		!IFTTT_EVENT.matches(action.event) -> "An event name is letters, digits, - and _"
		listOf(action.value1, action.value2, action.value3).any { it.length > MAX_IFTTT_VALUE_LEN } ->
			"At most $MAX_IFTTT_VALUE_LEN characters a value"
		else -> null
	}
	is ActionDraft.Kept -> null
}

/** Silent while an IFTTT event is still blank. */
internal fun actionHint(action: ActionDraft, offer: AutomationOffer): String? =
	if (action is ActionDraft.Ifttt && action.event.isBlank()) null else actionIssue(action, offer)

/** Blank text is left out. */
internal fun actionOf(action: ActionDraft): AutomationAction = when (action) {
	is ActionDraft.Tell -> AutomationAction.TellAssistant(`when` = action.told, message = action.message.ifBlank { null })
	is ActionDraft.DeviceSet -> AutomationAction.DeviceSet(action.device, action.verb)
	is ActionDraft.Ifttt -> AutomationAction.IftttTrigger(
		event = action.event,
		value1 = action.value1.ifBlank { null },
		value2 = action.value2.ifBlank { null },
		value3 = action.value3.ifBlank { null },
	)
	is ActionDraft.Kept -> action.action
}

/** Null when this Gateway offers no such action or holds nothing it could act on. */
internal fun freshAction(kind: String, offer: AutomationOffer): ActionDraft? = when (kind) {
	ACTION_TELL -> ActionDraft.Tell("now", "").takeUnless { offer.away }
	ACTION_DEVICE_SET -> offer.switches.firstOrNull()?.let { ActionDraft.DeviceSet(it.device, "on") }
	ACTION_IFTTT -> ActionDraft.Ifttt("", "", "", "").takeUnless { offer.away }
	else -> null
}

/** Actions the Add menu lists. */
internal fun addableActions(offer: AutomationOffer, held: List<ActionDraft>): List<ActionOffer> =
	if (held.size >= MAX_ACTIONS) emptyList()
	else offer.actions.filter { freshAction(it.kind, offer) != null }

internal fun actionLine(action: AutomationAction, offer: AutomationOffer = AutomationOffer()): String = when (action) {
	is AutomationAction.TellAssistant -> if (action.`when` == "quietly") "Tell the assistant quietly" else "Tell the assistant now"
	is AutomationAction.DeviceSet -> {
		val name = offer.switches.find { it.device == action.device }?.name ?: "a plug"
		when (action.verb) {
			"on" -> "Switch $name on"
			"off" -> "Switch $name off"
			else -> "Toggle $name"
		}
	}
	is AutomationAction.IftttTrigger -> "Send ${action.event} to IFTTT"
	is AutomationAction.Unknown -> action.kind
}

internal val WEEKDAY_LABELS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

internal val DIRECTIONS = listOf("below" to "Goes below", "above" to "Goes above")
internal val VERBS = listOf("on" to "On", "off" to "Off", "toggle" to "Toggle")
internal val TELLS = listOf("now" to "Now", "quietly" to "Quietly")
internal val CLOCK_KINDS = mapOf(TRIGGER_TIME to "At a time", TRIGGER_INTERVAL to "Every")

/** What a Gateway says of a text with holes. */
internal sealed interface TextPreview {
	/** Nothing to fill, or no trigger to fill from. */
	data object Plain : TextPreview

	data object Asking : TextPreview

	data object Unread : TextPreview

	data class Filled(val text: String) : TextPreview

	data class Refused(val line: String, val start: Int, val end: Int) : TextPreview
}

internal fun hasHole(text: String): Boolean = scanHoles(text).any { it is HolePart.Hole }

/** The text a preview asks about; null when it holds no hole. */
internal fun previewText(text: String): String? = text.takeIf(::hasHole)

/** One Gateway read of a preview. */
internal data class PreviewRead(val answer: ConsoleAutomationPreviewResult? = null, val failed: Boolean = false)

internal fun textPreviewOf(text: String, asked: Boolean, read: PreviewRead): TextPreview {
	val answer = read.answer
	val hole = answer?.hole
	val filled = answer?.filled
	return when {
		!asked || !hasHole(text) -> TextPreview.Plain
		read.failed -> TextPreview.Unread
		answer == null -> TextPreview.Asking
		hole != null -> TextPreview.Refused(hole.message, hole.start.toInt(), hole.end.toInt())
		filled != null -> TextPreview.Filled(filled)
		else -> TextPreview.Unread
	}
}

internal const val PARAM_MESSAGE = "message"
internal const val PARAM_VALUE1 = "value1"
internal const val PARAM_VALUE2 = "value2"
internal const val PARAM_VALUE3 = "value3"

/** An action with one of its texts replaced; the wire's parameter names. */
internal fun withText(action: ActionDraft, param: String, text: String): ActionDraft = when (action) {
	is ActionDraft.Tell -> if (param == PARAM_MESSAGE) action.copy(message = text) else action
	is ActionDraft.Ifttt -> when (param) {
		PARAM_VALUE1 -> action.copy(value1 = text)
		PARAM_VALUE2 -> action.copy(value2 = text)
		PARAM_VALUE3 -> action.copy(value3 = text)
		else -> action
	}
	is ActionDraft.DeviceSet, is ActionDraft.Kept -> action
}

/** A name's hole at the end of a text. */
internal fun withHole(text: String, name: String): String {
	val gap = if (text.isEmpty() || text.last().isWhitespace()) "" else " "
	return "$text$gap{$name}"
}

/** A refused span quoted before its reason. */
internal fun holeLine(text: String, line: String, start: Int, end: Int): String {
	val from = start.coerceIn(0, text.length)
	val quoted = text.substring(from, end.coerceIn(from, text.length))
	return if (quoted.isBlank()) line else "$quoted: $line"
}

internal fun freshClock(kind: String, zone: String): TriggerDraft? = when (kind) {
	TRIGGER_TIME -> TriggerDraft.Time("08:00", (1..7).toSet(), zone)
	TRIGGER_INTERVAL -> TriggerDraft.Interval("1", IntervalUnit.HOURS)
	else -> null
}

internal fun toggled(weekdays: Set<Int>, day: Int): Set<Int> = if (day in weekdays) weekdays - day else weekdays + day

internal fun confirmBody(labels: List<String>): String {
	val does = labels.joinToString(" and ") { it.replaceFirstChar(Char::lowercase) }
	return "Each time it runs it will $does, without asking you."
}

/** The hole a save refused, when it is this text's. */
internal fun refusedHole(said: AutomationSaid?, action: Int, param: String): AutomationSaid.Hole? =
	(said as? AutomationSaid.Hole)?.takeIf { it.action == action && it.param == param }
