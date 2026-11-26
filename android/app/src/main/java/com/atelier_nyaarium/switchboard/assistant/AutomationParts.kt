package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.displayedUnit
import com.atelier_nyaarium.switchboard.formatDecimal
import com.atelier_nyaarium.switchboard.fromDisplay
import com.atelier_nyaarium.switchboard.liveconsole.HolePart
import com.atelier_nyaarium.switchboard.liveconsole.scanHoles
import com.atelier_nyaarium.switchboard.parseDecimal
import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationCondition
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationServes
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.AutomationTriggerName
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationPreviewResult
import com.atelier_nyaarium.switchboard.proto.FieldTypes
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.CrossingDirection
import com.atelier_nyaarium.switchboard.roundTo
import com.atelier_nyaarium.switchboard.suffixOf
import com.atelier_nyaarium.switchboard.toDisplay

internal const val TRIGGER_EVENT = "event"
internal const val TRIGGER_CROSSING = "crossing"
internal const val TRIGGER_TIME = "time"
internal const val TRIGGER_INTERVAL = "interval"
private const val MAX_COOL_DOWN_MIN = Protocol.Wire.AUTOMATION_COOL_DOWN_MAX_SEC / 60L
private const val MINUTE_SEC = 60L
private const val COOL_DOWN_DECIMALS = 2
private val MAX_INTERVAL_MIN = Protocol.Wire.AUTOMATION_INTERVAL_MAX_MIN.toLong()
private const val FRESH_DEAD_ZONE = "0.5"
private val CLOCK = Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$")

internal data class NumberOffer(val device: String, val measure: String, val label: String, val unit: String?, val decimals: Int)

internal data class SwitchOffer(val device: String, val name: String)

/** A trigger kind and the names its texts may use. */
internal data class TriggerOffer(val kind: String, val names: List<AutomationTriggerName>)

internal data class AutomationOffer(
	val triggers: List<TriggerOffer>,
	val actions: List<ActionOffer>,
	val numbers: List<NumberOffer> = emptyList(),
	val switches: List<SwitchOffer> = emptyList(),
	/** Not the assistant's home: no event arrives, and an action that needs the home does nothing. */
	val away: Boolean,
	/** Null: this Gateway holds no functions. */
	val functions: FunctionOffer? = null,
) {
	fun action(kind: String): ActionOffer? = actions.find { it.kind == kind }

	fun holds(kind: String): Boolean = triggers.any { it.kind == kind }

	fun names(kind: String): List<AutomationTriggerName> = triggers.find { it.kind == kind }?.names.orEmpty()

	fun number(device: String, measure: String): NumberOffer? = numbers.find { it.device == device && it.measure == measure }

	fun dangerous(kind: String): Boolean = actions.any { it.kind == kind && it.danger }

	fun labelOf(kind: String): String = actions.find { it.kind == kind }?.label ?: kind
}

// Remove 2026-11-29: every listing names what it serves.
/** The event row a listing with no `serves` holds. */
private val LEGACY_EVENT = TriggerOffer(
	TRIGGER_EVENT,
	listOf(AutomationTriggerName("event", "The event; its fields by name"), AutomationTriggerName("source", "The source's name")),
)

// Remove 2026-11-29: every listing names what it serves.
/** A listing with no `serves` holds an event and a bare tell. */
/** `functions` from the same listing as `serves`. */
internal fun offerOf(serves: AutomationServes?, away: Boolean, functions: List<AutomationFunctionRow>? = null): AutomationOffer =
	if (serves == null) AutomationOffer(triggers = listOf(LEGACY_EVENT), actions = listOf(DEFAULT_TELL), away = away)
	else AutomationOffer(
		triggers = serves.triggers.map { TriggerOffer(it.kind, it.names) },
		actions = serves.actions.map(::actionOfferOf),
		numbers = serves.numbers.map { NumberOffer(it.device, it.measure, it.label, it.unit, it.decimals.toInt()) },
		switches = serves.switches.map { SwitchOffer(it.device, it.name) },
		away = away,
		functions = serves.functions?.let { FunctionOffer(it, functions.orEmpty()) },
	)

/** Stored text, minted while its unit was unknown. */
private fun TriggerDraft.Crossing.raw(offer: AutomationOffer): Boolean =
	unit == null && offer.number(device, measure).let { it == null || it.unit != null }

/** Raw text converts for its own number and clears for another. */
internal fun TriggerDraft.Crossing.picked(number: NumberOffer, offer: AutomationOffer, display: String?): TriggerDraft.Crossing {
	val picked = copy(device = number.device, measure = number.measure, unit = number.unit)
	if (!raw(offer)) return picked
	if (number.device != device || number.measure != measure) return picked.copy(threshold = "", deadZone = FRESH_DEAD_ZONE)
	val stored = parseDecimal(threshold.trim())
	val width = parseDecimal(deadZone.trim())
	return picked.copy(
		threshold = stored?.let { typedOf(it, number.unit, number.decimals, display) } ?: threshold,
		deadZone = width?.let { typedWidthOf(it, number.unit, number.decimals, display) } ?: deadZone,
	)
}

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
		/** Stored unit. */
		val unit: String?,
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

internal enum class TriggerChoice(val label: String, val kinds: Set<String>) {
	EVENT("Event arrives", setOf(TRIGGER_EVENT)),
	CROSSING("Value crosses", setOf(TRIGGER_CROSSING)),
	TIME("Time comes", setOf(TRIGGER_TIME, TRIGGER_INTERVAL)),
}

internal fun choiceOf(trigger: TriggerDraft): TriggerChoice = TriggerChoice.entries.first { trigger.kind in it.kinds }

internal fun offersChoice(offer: AutomationOffer, choice: TriggerChoice, sources: Boolean): Boolean = when (choice) {
	TriggerChoice.EVENT -> offer.holds(TRIGGER_EVENT) && sources && !offer.away
	TriggerChoice.CROSSING -> offer.holds(TRIGGER_CROSSING) && offer.numbers.isNotEmpty()
	TriggerChoice.TIME -> choice.kinds.any(offer::holds)
}

/** The clock kinds a Gateway holds, a time first. */
internal fun clockKinds(offer: AutomationOffer): List<String> = listOf(TRIGGER_TIME, TRIGGER_INTERVAL).filter(offer::holds)

internal fun numberSuffix(unit: String?, display: String?): String =
	unit?.let { suffixOf(displayedUnit(it, display)) }.orEmpty()

/** Raw text reads in its stored unit. */
internal fun crossingSuffix(unit: String?, offered: String?, display: String?): String =
	if (unit != null) numberSuffix(unit, display) else numberSuffix(offered, null)

private fun scaleOf(unit: String?, display: String?): Double =
	FieldTypes.UNIT_DISPLAYS.find { it.unit == unit && it.display == display }?.scale ?: 1.0

private fun typedOf(value: Double, unit: String?, decimals: Int, display: String?): String {
	val shown = if (unit != null && display != null) toDisplay(value, unit, display).value else value
	return formatDecimal(shown, decimals)
}

/** Stored precision, trimmed. */
private fun rawTyped(value: Double): String =
	formatDecimal(value, FieldTypes.CONVERTED_DECIMALS).trimEnd('0').trimEnd('.')

/** A width scales without the unit's offset. */
private fun typedWidthOf(value: Double, unit: String?, decimals: Int, display: String?): String =
	formatDecimal(value * scaleOf(unit, display), decimals)

/** Whole minutes plain, else to two places, which reads back to the same second. */
internal fun coolDownTyped(seconds: Long): String =
	if (seconds % MINUTE_SEC == 0L) (seconds / MINUTE_SEC).toString()
	else formatDecimal(seconds.toDouble() / MINUTE_SEC, COOL_DOWN_DECIMALS).trimEnd('0')

/** Null outside 0 to a day. */
internal fun coolDownSecOf(typed: String): Long? {
	val minutes = parseDecimal(typed.trim())?.takeIf { it in 0.0..MAX_COOL_DOWN_MIN.toDouble() } ?: return null
	return Math.round(minutes * MINUTE_SEC)
}

/** Null for a kind the editor does not draw. */
internal fun triggerDraftOf(trigger: AutomationTrigger, offer: AutomationOffer, display: String?): TriggerDraft? = when (trigger) {
	is AutomationTrigger.Event -> TriggerDraft.Event(trigger.source, trigger.conditions)
	is AutomationTrigger.Crossing -> {
		val number = offer.number(trigger.device, trigger.measure)
		val decimals = number?.decimals ?: 1
		TriggerDraft.Crossing(
			device = trigger.device,
			measure = trigger.measure,
			direction = trigger.direction,
			threshold = if (number == null) rawTyped(trigger.threshold) else typedOf(trigger.threshold, number.unit, decimals, display),
			deadZone = if (number == null) rawTyped(trigger.deadZone) else typedWidthOf(trigger.deadZone, number.unit, decimals, display),
			coolDownMin = coolDownTyped(trigger.coolDownSec),
			unit = number?.unit,
		)
	}
	is AutomationTrigger.Time -> TriggerDraft.Time(trigger.time, trigger.weekdays.map { it.toInt() }.toSet(), trigger.zone)
	is AutomationTrigger.Interval -> {
		val unit = IntervalUnit.entries.last { trigger.everyMin % it.minutes == 0L }
		TriggerDraft.Interval((trigger.everyMin / unit.minutes).toString(), unit)
	}
	is AutomationTrigger.Value, is AutomationTrigger.Unknown -> null
}

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
		coolDownSecOf(trigger.coolDownMin) == null -> "The cool-down is 0 to $MAX_COOL_DOWN_MIN minutes"
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
			val typed = parseDecimal(trigger.threshold.trim()) ?: return null
			val width = parseDecimal(trigger.deadZone.trim()) ?: return null
			val unit = trigger.unit
			AutomationTrigger.Crossing(
				device = trigger.device,
				measure = trigger.measure,
				direction = trigger.direction,
				threshold = if (unit != null && display != null) fromDisplay(typed, unit, display) else typed,
				deadZone = roundTo(width / scaleOf(unit, display), FieldTypes.CONVERTED_DECIMALS),
				coolDownSec = coolDownSecOf(trigger.coolDownMin) ?: return null,
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
		TriggerDraft.Crossing(it.device, it.measure, "below", "", FRESH_DEAD_ZONE, "10", it.unit)
	}
	TriggerChoice.TIME -> clockKinds(offer).firstNotNullOfOrNull { freshClock(it, zone) }
}

internal val WEEKDAY_LABELS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

private fun directionLabel(direction: CrossingDirection): String = when (direction) {
	CrossingDirection.ABOVE -> "Goes above"
	CrossingDirection.BELOW -> "Goes below"
}

internal val DIRECTIONS = listOf(CrossingDirection.BELOW, CrossingDirection.ABOVE).map { it.wire to directionLabel(it) }
internal val CLOCK_KINDS = mapOf(TRIGGER_TIME to "At a time", TRIGGER_INTERVAL to "Every")

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

/** The refused hole, while its text stands. */
internal fun refusedHole(said: AutomationSaid?, action: Int, param: String, text: String): AutomationSaid.Hole? =
	(said as? AutomationSaid.Hole)?.takeIf { it.action == action && it.param == param && it.text == text }

/** Refused text. */
internal fun saidText(draft: AutomationDraft, at: SaidAt): String = when (at) {
	is SaidAt.Value -> (draft.runs as? RunsHead.Points)?.pointing?.let { pointing ->
		pointing.params.firstOrNull { it.param.name == at.param }?.let { pointing.values[it.key] }
	}.orEmpty()
	is SaidAt.Card -> (draft.actions.getOrNull(at.action) as? ActionDraft.Filled)?.values?.get(at.param).orEmpty()
}

/** Refusal while text stands. */
internal fun refusedField(said: AutomationSaid?, at: SaidAt, text: String): String? =
	(said as? AutomationSaid.Field)?.takeIf { it.at == at && it.text == text }?.line

private fun drawsField(draft: AutomationDraft, at: SaidAt, offer: AutomationOffer): Boolean = when (at) {
	is SaidAt.Value -> offer.functions != null &&
		(draft.runs as? RunsHead.Points)?.pointing?.params?.any { it.param.name == at.param } == true
	is SaidAt.Card -> draft.runs !is RunsHead.Kept &&
		(draft.actions.getOrNull(at.action) as? ActionDraft.Filled)?.let { card -> actionFields(card, offer).any { it.param?.name == at.param } } == true
}

/** What no field draws. */
internal fun generalLine(said: AutomationSaid?, draft: AutomationDraft, offer: AutomationOffer): String? = when (said) {
	null -> null
	is AutomationSaid.Hole ->
		holeLine(said.text, said.line, said.start, said.end).takeIf { textParam(draft, TextRef(said.action, said.param), offer) == null }
	is AutomationSaid.Field -> said.line.takeUnless { drawsField(draft, said.at, offer) }
	is AutomationSaid.Line, is AutomationSaid.Confirm -> said.line
}
