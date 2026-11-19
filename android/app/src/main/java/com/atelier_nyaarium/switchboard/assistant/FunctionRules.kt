package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationHoleSpan
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionServes
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationSaveRecord
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.AutomationSaveRefusalCode
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.FunctionParamType
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.GivenType
import com.atelier_nyaarium.switchboard.proto.FunctionReads

/** What a Gateway holds of functions. */
internal data class FunctionOffer(val served: AutomationFunctionServes, val rows: List<AutomationFunctionRow>) {
	fun row(id: String): AutomationFunctionRow? = rows.firstOrNull { it.id == id }
}

/** How a value's type is named. */
internal sealed interface TypeWord {
	/** A crossing's measure. */
	data class Measure(val measure: String) : TypeWord

	data class Given(val type: GivenType) : TypeWord

	/** A declared type's wire word. */
	data class Declared(val type: String) : TypeWord
}

internal sealed interface ValueSource {
	data object FromTrigger : ValueSource

	data class Set(val text: String) : ValueSource

	data object Unset : ValueSource
}

internal data class ValueRow(val param: FunctionParam, val type: TypeWord, val source: ValueSource)

private val NO_READS = FunctionReads(emptyList(), emptyList())

/** Names a crossing gives in its measure. */
private val MEASURED = setOf("value", "threshold")

/** A crossing's sensor, read as a device. */
private const val SENSOR = "device"

/** `measure` is a crossing's; null otherwise. */
internal fun givenWord(name: String, type: GivenType, measure: String?): TypeWord = when {
	measure != null && type == GivenType.NUMBER && name in MEASURED -> TypeWord.Measure(measure)
	// Display only; fit reads text.
	measure != null && name == SENSOR -> TypeWord.Given(GivenType.DEVICE)
	else -> TypeWord.Given(type)
}

/** One row per value the function takes. */
internal fun valueRows(params: List<FunctionParam>, given: TriggerGiven, values: Map<String, String>, measure: String?): List<ValueRow> =
	params.map { param ->
		val gives = given.names.firstOrNull { it.name == param.name }
		when {
			gives != null -> ValueRow(param, givenWord(param.name, gives.type, measure), ValueSource.FromTrigger)
			values[param.name].isNullOrBlank() -> ValueRow(param, TypeWord.Declared(param.type), ValueSource.Unset)
			else -> ValueRow(param, TypeWord.Declared(param.type), ValueSource.Set(values.getValue(param.name)))
		}
	}

internal enum class ValueIssue { UNKNOWN_DEVICE, NOT_A_NUMBER }

internal fun valueIssue(param: FunctionParam, text: String, offer: AutomationOffer): ValueIssue? = when (param.type) {
	FunctionParamType.DEVICE.wire -> ValueIssue.UNKNOWN_DEVICE.takeIf { offer.switches.none { it.device == text } }
	FunctionParamType.NUMBER.wire -> ValueIssue.NOT_A_NUMBER.takeIf { functionValueOf(param, text) == null }
	else -> null
}

/** What blocks Save in the Runs block. */
internal sealed interface RunsIssue {
	data object NoSteps : RunsIssue

	data class Step(val index: Int, val line: String) : RunsIssue

	/** Cannot be a function's step. */
	data class NotAStep(val index: Int) : RunsIssue

	data class Unset(val name: String) : RunsIssue

	data class BadValue(val name: String, val issue: ValueIssue) : RunsIssue

	data class Unfit(val fit: FitAnswer) : RunsIssue

	/** Its name was cleared while others run it. */
	data class SharedName(val users: Int) : RunsIssue
}

private fun stepIssue(steps: List<ActionDraft>, offer: AutomationOffer): RunsIssue? {
	if (steps.isEmpty()) return RunsIssue.NoSteps
	return steps.withIndex().firstNotNullOfOrNull { (at, step) -> actionIssue(step, offer)?.let { RunsIssue.Step(at, it) } }
}

/** `servedSteps`: the kinds a function's step may name; `reads` from its row. */
internal fun runsIssue(runs: RunsDraft, given: TriggerGiven, offer: AutomationOffer, servedSteps: List<String>, reads: FunctionReads?): RunsIssue? =
	when (runs) {
		is RunsDraft.Kept -> null
		is RunsDraft.Flat -> stepIssue(runs.actions, offer) ?: if (runs.name.isBlank()) {
			null
		} else {
			runs.actions.withIndex().firstOrNull { (_, action) -> action.kind !in servedSteps || stepOf(action, offer) == null }
				?.let { RunsIssue.NotAStep(it.index) }
		}
		is RunsDraft.Pointing -> stepIssue(runs.steps, offer) ?: pointingIssue(runs, given, offer, reads)
	}

private fun pointingIssue(runs: RunsDraft.Pointing, given: TriggerGiven, offer: AutomationOffer, reads: FunctionReads?): RunsIssue? {
	if (runs.name.isBlank()) {
		if (sharedName(runs)) return RunsIssue.SharedName(runs.others.size + 1)
		return runs.steps.withIndex().firstOrNull { (_, step) -> step is ActionDraft.Kept }?.let { RunsIssue.NotAStep(it.index) }
	}
	for (row in valueRows(runs.params, given, runs.values, measure = null)) {
		when (val source = row.source) {
			ValueSource.FromTrigger -> Unit
			ValueSource.Unset -> return RunsIssue.Unset(row.param.name)
			is ValueSource.Set -> valueIssue(row.param, source.text, offer)?.let { return RunsIssue.BadValue(row.param.name, it) }
		}
	}
	val typed = runs.params.mapNotNull { param -> runs.values[param.name]?.let { functionValueOf(param, it) }?.let { param.name to it } }.toMap()
	val fit = fitOf(given, runs.params, reads ?: NO_READS, typed)
	return RunsIssue.Unfit(fit).takeIf { fit.hidden || fit.requires.isNotEmpty() || fit.wrong.isNotEmpty() }
}

/** What the Runs block draws. */
internal data class RunsView(
	/** Typed name; blank shows the placeholder. */
	val name: String,
	val nameEditable: Boolean,
	val usedBy: Int?,
	val values: List<ValueRow>,
	/** Other users' sentences. */
	val reach: List<String>,
	val unique: Boolean,
	val makeUnique: Boolean,
	val kept: Boolean,
	val issue: RunsIssue?,
)

/** Null where functions are not served. */
internal fun runsView(draft: AutomationDraft, fields: SourceFields, offer: AutomationOffer, rows: List<AutomationRow>): RunsView? {
	val functions = offer.functions ?: return null
	val issue = draftRunsIssue(draft, fields, offer)
	return when (val runs = draft.runsDraft()) {
		is RunsDraft.Flat -> RunsView(runs.name, true, null, emptyList(), emptyList(), unique = false, makeUnique = false, kept = false, issue = issue)
		is RunsDraft.Kept -> RunsView("", false, null, emptyList(), emptyList(), unique = false, makeUnique = false, kept = true, issue = null)
		is RunsDraft.Pointing -> {
			val shared = sharedName(runs)
			val row = functions.row(runs.functionId)
			RunsView(
				name = runs.name,
				nameEditable = true,
				usedBy = if (shared) runs.others.size + 1 else null,
				values = valueRows(runs.params, givenOf(draft, fields), runs.values, measureOf(draft)),
				reach = if (shared && row != null) reachLine(row, draft.id, rows) else emptyList(),
				unique = runs.mode == PointMode.UNIQUE,
				makeUnique = shared,
				kept = false,
				issue = issue,
			)
		}
	}
}

/** The list row's function, under its trigger. */
internal sealed interface FunctionLine {
	/** `count` only when shared. */
	data class Named(val name: String, val count: Int?) : FunctionLine

	/** Its function is not listed. */
	data object Unlisted : FunctionLine
}

/** Null for an automation with its own steps. */
internal fun functionLine(row: AutomationRow, functions: List<AutomationFunctionRow>?): FunctionLine? {
	val pointer = pointerOf(row.automation) ?: return null
	val held = functions?.firstOrNull { it.id == pointer } ?: return FunctionLine.Unlisted
	return FunctionLine.Named(held.function.name, usersCount(held))
}

/** Null where functions are not served or it runs its own steps. */
internal fun rowFunction(row: AutomationRow, served: Served): FunctionLine? = when (served) {
	is Served.Known -> served.offer.functions?.let { functionLine(row, it.rows) }
	is Served.Unknown -> null
}

/** Shown only above one. */
internal fun usersCount(function: AutomationFunctionRow): Int? = function.users.size.takeIf { it > 1 }

/** Who else an edit reaches, by their sentences. */
internal fun reachLine(function: AutomationFunctionRow, selfId: String, rows: List<AutomationRow>): List<String> =
	function.users.filter { it != selfId }.mapNotNull { id -> rows.firstOrNull { it.id == id }?.sentence }

/** The function a delete takes with it, by name. */
internal fun automationDeleteTakes(row: AutomationRow, functions: List<AutomationFunctionRow>?): String? {
	val pointer = pointerOf(row.automation) ?: return null
	return functions?.firstOrNull { it.id == pointer }?.takeIf { it.users == listOf(row.id) }?.function?.name
}

internal data class PickerRow(val function: AutomationFunctionRow, val signature: List<Pair<String, TypeWord>>, val count: Int)

/** What this trigger could run: no other source's event, nothing it lacks. */
internal fun pickerChoices(given: TriggerGiven, functions: List<AutomationFunctionRow>, measure: String?): List<PickerRow> =
	functions
		.filter { row ->
			val fit = fitOf(given, row.function.params, row.reads, emptyMap())
			!fit.hidden && fit.requires.isEmpty() && fit.wrong.isEmpty()
		}
		.sortedWith(compareByDescending<AutomationFunctionRow> { it.users.size }.thenBy { it.function.name.lowercase() }.thenBy { it.id })
		.map { row ->
			val signature = row.function.params.map { param ->
				param.name to (given.names.firstOrNull { it.name == param.name }?.let { givenWord(param.name, it.type, measure) } ?: TypeWord.Declared(param.type))
			}
			PickerRow(row, signature, row.users.size)
		}

/** How a save came back. */
internal sealed interface SaveAnswer {
	data class Stored(val automation: AutomationRow?, val function: AutomationFunctionRow?) : SaveAnswer

	/** Ask once, then send with `confirmed`. */
	data class Confirm(val labels: List<String>) : SaveAnswer

	/** Lands on its field. */
	data class Hole(val record: AutomationSaveRecord?, val path: String?, val param: String?, val start: Long?, val end: Long?) : SaveAnswer

	/** `code` null for one this build does not know. */
	data class Refused(val code: AutomationSaveRefusalCode?, val refusal: AutomationSaveRefusal) : SaveAnswer
}

/** The function it points at. */
internal fun pointerOf(automation: Automation): String? = (written(automation).singleOrNull() as? AutomationAction.RunFunction)?.function

/** A hole on the drawn cards, by the step's index. */
internal fun holeSpanOf(hole: SaveAnswer.Hole): AutomationHoleSpan? {
	val at = hole.path?.toLongOrNull() ?: return null
	return AutomationHoleSpan(action = at, param = hole.param ?: return null, start = hole.start ?: return null, end = hole.end ?: return null)
}

/** Only the automation's own move offers its row. */
internal fun movedAutomation(refused: SaveAnswer.Refused): Boolean =
	refused.code == AutomationSaveRefusalCode.MOVED && refused.refusal.record == AutomationSaveRecord.AUTOMATION.wire

internal fun saveAnswerOf(result: ConsoleAutomationSaveResult): SaveAnswer {
	if (result.stored) return SaveAnswer.Stored(result.automation, result.function)
	val refusal = result.refusal ?: return SaveAnswer.Refused(null, AutomationSaveRefusal(code = ""))
	val code = AutomationSaveRefusalCode.entries.find { it.wire == refusal.code } ?: return SaveAnswer.Refused(null, refusal)
	return when (code) {
		AutomationSaveRefusalCode.CONFIRM -> SaveAnswer.Confirm(refusal.labels.orEmpty())
		AutomationSaveRefusalCode.HOLE -> SaveAnswer.Hole(
			refusal.record?.let { word -> AutomationSaveRecord.entries.find { it.wire == word } },
			refusal.path,
			refusal.param,
			refusal.start,
			refusal.end,
		)
		AutomationSaveRefusalCode.MOVED,
		AutomationSaveRefusalCode.GONE,
		AutomationSaveRefusalCode.FULL,
		AutomationSaveRefusalCode.INVALID,
		AutomationSaveRefusalCode.UNFIT,
		AutomationSaveRefusalCode.UNKNOWN_FUNCTION,
		AutomationSaveRefusalCode.MIXED,
		AutomationSaveRefusalCode.NEWER_APP,
		AutomationSaveRefusalCode.NOT_HOME,
		AutomationSaveRefusalCode.COOL_DOWN_TWICE,
		AutomationSaveRefusalCode.NEWER_FUNCTION,
		AutomationSaveRefusalCode.NO_KEY,
		AutomationSaveRefusalCode.UNWRITTEN,
		AutomationSaveRefusalCode.NEWER_AUTOMATION,
		AutomationSaveRefusalCode.NO_FREE_ID,
		-> SaveAnswer.Refused(code, refusal)
	}
}
