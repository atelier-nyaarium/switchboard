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
import com.atelier_nyaarium.switchboard.proto.Protocol
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

	data class Mismatch(val gets: GivenType, val wants: String) : ValueSource
}

internal data class ValueRow(
	val name: String,
	val type: TypeWord,
	val source: ValueSource,
	val param: FunctionParam? = null,
	val index: Int? = null,
	val issue: ParamIssue? = null,
	/** A save's refusal here. */
	val refused: String? = null,
	val key: String? = null,
)

internal data class PlugChoice(val device: String, val label: String, val reference: FunctionValueReference? = null)

internal fun plugChoices(functionParams: List<FunctionValueDraft>, offer: AutomationOffer): List<PlugChoice> =
	functionParams
		.filter { it.param.type == FunctionParamType.DEVICE.wire && it.param.name.isNotBlank() }
		.map { PlugChoice(it.key, "${it.param.name} (value)", FunctionValueReference(it.key, it.param.name)) } +
		offer.switches.map { PlugChoice(it.device, it.name) }

internal fun storePlugChoice(action: ActionDraft, param: String, choice: PlugChoice): ActionDraft =
	choice.reference?.let { withReference(action, param, it) } ?: withValue(action, param, choice.device)

internal enum class ParamIssue { EMPTY, INVALID, DUPLICATE }

/** Names a crossing gives in its measure. */
private val MEASURED = setOf("value", "threshold")

/** `measure` is a crossing's; null otherwise. */
internal fun givenWord(name: String, type: GivenType, measure: String?): TypeWord = when {
	measure != null && type == GivenType.NUMBER && name in MEASURED -> TypeWord.Measure(measure)
	else -> TypeWord.Given(type)
}

internal fun valueRows(
	params: List<FunctionParam>,
	given: TriggerGiven,
	values: Map<String, String>,
	measure: String?,
	reads: FunctionReads? = null,
): List<ValueRow> {
	val declared = params.map { it.name }.toSet()
	val readRows = reads?.names.orEmpty().filter { it !in declared }.map { name ->
		val gets = given.names.firstOrNull { it.name == name }?.type
		ValueRow(name, gets?.let { givenWord(name, it, measure) } ?: TypeWord.Declared("text"), if (gets == null) ValueSource.Unset else ValueSource.FromTrigger)
	}
	val issues = paramIssues(params, given)
	val paramRows = params.mapIndexed { index, param ->
		val gets = given.names.firstOrNull { it.name == param.name }?.type
		when {
			gets != null && gets == paramType(param.type) -> ValueRow(param.name, givenWord(param.name, gets, measure), ValueSource.FromTrigger, param, index, issues.getOrNull(index))
			gets != null -> ValueRow(param.name, TypeWord.Declared(param.type), ValueSource.Mismatch(gets, param.type), param, index, issues.getOrNull(index))
			values[param.name].isNullOrBlank() -> ValueRow(param.name, TypeWord.Declared(param.type), ValueSource.Unset, param, index, issues.getOrNull(index))
			else -> ValueRow(param.name, TypeWord.Declared(param.type), ValueSource.Set(values.getValue(param.name)), param, index, issues.getOrNull(index))
		}
	}
	return readRows + paramRows
}

private fun paramType(type: String): GivenType? = GivenType.entries.firstOrNull { it.wire == type }

internal fun functionParamTypeText(type: String): String = when (type) {
	FunctionParamType.DEVICE.wire -> "Device"
	FunctionParamType.TEXT.wire -> "Text"
	FunctionParamType.NUMBER.wire -> "Number"
	else -> type
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

	data object NameWithValues : RunsIssue

	data class BadParam(val name: String, val issue: ParamIssue) : RunsIssue

	data object TooManyParams : RunsIssue

	data class BadValue(val name: String, val issue: ValueIssue) : RunsIssue

	/** Its name was cleared while others run it. */
	data class SharedName(val users: Int) : RunsIssue

	data class NameTooLong(val max: Int) : RunsIssue
}

private fun nameIssue(name: String): RunsIssue? =
	RunsIssue.NameTooLong(Protocol.Wire.FUNCTION_NAME_MAX).takeIf { name.trim().length > Protocol.Wire.FUNCTION_NAME_MAX }

private fun stepIssue(steps: List<ActionDraft>, offer: AutomationOffer): RunsIssue? {
	if (steps.isEmpty()) return RunsIssue.NoSteps
	return steps.withIndex().firstNotNullOfOrNull { (at, step) -> actionIssue(step, offer)?.let { RunsIssue.Step(at, it) } }
}

private fun stepIssue(steps: List<ActionDraft>, offer: AutomationOffer, params: List<FunctionValueDraft>): RunsIssue? {
	if (steps.isEmpty()) return RunsIssue.NoSteps
	val byKey = params.associateBy { it.key }
	return steps.withIndex().firstNotNullOfOrNull { (at, step) ->
		val filled = step as? ActionDraft.Filled
		val refIssue = filled?.references?.values?.firstNotNullOfOrNull { reference ->
			val value = byKey[reference.key]
			when {
				value == null -> "${reference.name} is no longer a value; pick again"
				value.param.type != FunctionParamType.DEVICE.wire -> "${value.param.name} needs a Device value"
				else -> null
			}
		}
		(refIssue ?: actionIssue(step, offer, byKey.keys))?.let { RunsIssue.Step(at, it) }
	}
}

private fun paramIssues(params: List<FunctionParam>, given: TriggerGiven): List<ParamIssue?> {
	val nameCounts = params.filter { it.name.isNotBlank() }.groupingBy { it.name }.eachCount()
	return params.map { param ->
		when {
			param.name.isBlank() -> ParamIssue.EMPTY
			param.name.length > Protocol.Wire.FUNCTION_PARAM_NAME_MAX ||
				!Regex(Protocol.Wire.FUNCTION_PARAM_NAME_PATTERN).matches(param.name) -> ParamIssue.INVALID
			nameCounts[param.name] != 1 -> ParamIssue.DUPLICATE
			else -> null
		}
	}
}

/** Null when edited. */
internal fun runsIssue(
	runs: RunsDraft,
	selfId: String,
	given: TriggerGiven,
	offer: AutomationOffer,
): RunsIssue? =
	when (runs) {
		is RunsDraft.Kept -> null
		is RunsDraft.Flat -> stepIssue(runs.actions, offer)
		is RunsDraft.Pointing -> stepIssue(runs.steps, offer, runs.params) ?: pointingIssue(runs, selfId, given, offer)
	}

private fun pointingIssue(
	runs: RunsDraft.Pointing,
	selfId: String,
	given: TriggerGiven,
	offer: AutomationOffer,
): RunsIssue? {
	if (runs.name.isBlank()) {
		val others = othersOf(runs, selfId, offer.functions)
		if (sharedName(runs, others)) return RunsIssue.SharedName(others.size + 1)
		if (runs.params.isNotEmpty() || runs.steps.any { (it as? ActionDraft.Filled)?.references?.isNotEmpty() == true }) return RunsIssue.NameWithValues
		return runs.steps.withIndex().firstOrNull { (_, step) -> step is ActionDraft.Kept }?.let { RunsIssue.NotAStep(it.index) }
	}
	nameIssue(runs.name)?.let { return it }
	val wireParams = runs.wireParams()
	val values = runs.valuesByName()
	runs.steps.withIndex().firstOrNull { (_, step) -> stepOf(step, offer, runs.params) == null }?.let { return RunsIssue.NotAStep(it.index) }
	if (runs.params.size > Protocol.Wire.FUNCTION_PARAMS_MAX) return RunsIssue.TooManyParams
	val paramIssues = paramIssues(wireParams, given)
	paramIssues.forEachIndexed { index, issue -> if (issue != null) return RunsIssue.BadParam(wireParams.getOrNull(index)?.name.orEmpty(), issue) }
	for (row in valueRows(wireParams, given, values, measure = null)) {
		when (val source = row.source) {
			ValueSource.FromTrigger -> Unit
			is ValueSource.Mismatch -> Unit
			ValueSource.Unset -> row.param?.let { return RunsIssue.Unset(it.name) }
			is ValueSource.Set -> row.param?.let { param -> valueIssue(param, source.text, offer)?.let { return RunsIssue.BadValue(param.name, it) } }
		}
	}
	return null
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
	/** Its function's invalid line. */
	val invalid: String? = null,
	val moved: Boolean = false,
) {
	/** No empty header. */
	val reachHeader: Boolean get() = reach.isNotEmpty()
}

internal fun canAddValue(view: RunsView): Boolean =
	!view.kept && view.name.isNotBlank() && view.values.count { it.param != null } < Protocol.Wire.FUNCTION_PARAMS_MAX

/** Cards draw own. */
private fun blockIssue(issue: RunsIssue?): RunsIssue? = when (issue) {
	null, RunsIssue.NoSteps, is RunsIssue.Step -> null
	is RunsIssue.NotAStep,
	is RunsIssue.Unset,
	RunsIssue.NameWithValues,
	is RunsIssue.BadParam,
	is RunsIssue.BadValue,
	is RunsIssue.SharedName,
	is RunsIssue.NameTooLong,
	RunsIssue.TooManyParams,
	-> issue
}

/** Null where functions are not served. */
internal fun runsView(
	draft: AutomationDraft,
	fields: SourceFields,
	offer: AutomationOffer,
	rows: List<AutomationRow>,
	said: AutomationSaid? = null,
	read: CheckRead = CheckRead(),
): RunsView? {
	val functions = offer.functions ?: return null
	val issue = blockIssue(draftRunsIssue(draft, fields, offer))
	return when (val runs = draft.runsDraft()) {
		is RunsDraft.Flat -> RunsView("", true, null, emptyList(), emptyList(), unique = false, makeUnique = false, kept = false, issue = issue)
		is RunsDraft.Kept -> RunsView("", false, null, emptyList(), emptyList(), unique = false, makeUnique = false, kept = true, issue = null)
		is RunsDraft.Pointing -> {
			val others = othersOf(runs, draft.id, functions)
			val shared = sharedName(runs, others)
			val row = functions.row(runs.functionId)
			val reads = checkedReads(read, runs.functionId) ?: row?.reads
			RunsView(
				name = runs.name,
				nameEditable = true,
				usedBy = if (shared) others.size + 1 else null,
				values = valueRows(runs.wireParams(), givenOf(draft, fields), runs.valuesByName(), measureOf(draft), reads).map { value ->
					val at = SaidAt.Value(value.name)
					value.copy(
						refused = refusedField(said, at, saidText(draft, at)),
						key = value.index?.let { runs.params.getOrNull(it)?.key },
					)
				},
				reach = if (shared && row != null) reachLine(row, draft.id, rows) else emptyList(),
				unique = runs.mode == PointMode.UNIQUE,
				makeUnique = shared,
				kept = false,
				issue = issue,
				invalid = row?.invalid,
				moved = movedFor(said, runs),
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

internal data class PickerRow(
	val function: AutomationFunctionRow,
	val signature: List<Pair<String, TypeWord>>,
	val count: Int,
	/** The one pointed at. */
	val current: Boolean = false,
	/** Its invalid line. */
	val invalid: String? = null,
)

/** What fits, current first. */
internal fun pickerChoices(given: TriggerGiven, functions: List<AutomationFunctionRow>, measure: String?, current: String? = null): List<PickerRow> =
	functions
		.filter { row ->
			val fit = fitOf(given, row.function.params, row.reads, emptyMap())
			!fit.hidden && fit.requires.isEmpty() && fit.wrong.isEmpty()
		}
		.sortedWith(
			compareBy<AutomationFunctionRow> { it.id != current }
				.thenByDescending { it.users.size }
				.thenBy { it.function.name.lowercase() }
				.thenBy { it.id },
		)
		.map { row ->
			val params = row.function.params.associateBy { it.name }
			val names = row.reads.names + row.function.params.map { it.name }.filter { it !in row.reads.names }
			val signature = names.map { name ->
				val source = given.names.firstOrNull { it.name == name }
				val type = source?.let { givenWord(name, it.type, measure) }
					?: params[name]?.let { TypeWord.Declared(it.type) }
					?: TypeWord.Declared("text")
				name to type
			}
			PickerRow(row, signature, row.users.size, current = row.id == current, invalid = row.invalid)
		}

/** Stored sentence, trigger unchanged. */
internal fun pickerSubtitle(trigger: TriggerDraft, opened: TriggerDraft, sentence: String?): String? = sentence.takeIf { trigger == opened }

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

/** A row or field it names. */
internal fun refusedAtOf(refusal: AutomationSaveRefusal): SaidAt? {
	if (refusal.code != AutomationSaveRefusalCode.INVALID.wire) return null
	val parts = refusal.path?.split(".") ?: return null
	return when {
		parts.size == 2 && parts[0] == VALUES -> SaidAt.Value(parts[1])
		parts.size == 3 && parts[0] == STEPS -> parts[1].toIntOrNull()?.let { SaidAt.Card(it, parts[2]) }
		else -> null
	}
}

private const val VALUES = "values"

private const val STEPS = "steps"

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
		AutomationSaveRefusalCode.NEWER_FUNCTION,
		AutomationSaveRefusalCode.NO_KEY,
		AutomationSaveRefusalCode.UNWRITTEN,
		AutomationSaveRefusalCode.NEWER_AUTOMATION,
		AutomationSaveRefusalCode.NO_FREE_ID,
		AutomationSaveRefusalCode.LOOP,
		AutomationSaveRefusalCode.PRIVATE,
		-> SaveAnswer.Refused(code, refusal)
	}
}
