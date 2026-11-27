package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationHoleSpan
import com.atelier_nyaarium.switchboard.proto.AutomationIssue
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionServes
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationSaveRefusal
import com.atelier_nyaarium.switchboard.proto.ConsoleAutomationSaveResult
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
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

/** Write blockers only. */
internal sealed interface RunsIssue {
	data object NoSteps : RunsIssue

	/** The card at `key` cannot be a function's step. */
	data class NotAStep(val key: String) : RunsIssue

	/** Requires a named function. */
	data class NeedsName(val key: String) : RunsIssue

	data class InCallee(val name: String) : RunsIssue

	data object NameWithValues : RunsIssue

	data class BadParam(val name: String, val issue: ParamIssue) : RunsIssue

	data object TooManyParams : RunsIssue

	/** Its name was cleared while others run it. */
	data class SharedName(val users: Int) : RunsIssue

	data class NameTooLong(val max: Int) : RunsIssue
}

/** Never blocks Save. */
internal sealed interface RunsNote {
	data class Unset(val name: String) : RunsNote

	data class BadValue(val name: String, val issue: ValueIssue) : RunsNote
}

private fun nameIssue(name: String): RunsIssue? =
	RunsIssue.NameTooLong(Protocol.Wire.FUNCTION_NAME_MAX).takeIf { name.trim().length > Protocol.Wire.FUNCTION_NAME_MAX }

/** A typed value its type cannot read. */
internal fun callValueIssue(step: StepDraft.Call, calleeParams: CalleeParams): String? {
	val params = calleeParams(step.function).orEmpty().associateBy { it.name }
	return step.values.entries.firstNotNullOfOrNull { (name, value) ->
		val param = params[name] ?: return@firstNotNullOfOrNull null
		"$name is a number".takeIf { value is CallValue.Typed && value.text.isNotBlank() && functionValueOf(param, value.text) == null }
	}
}

private fun notPlain(steps: List<StepDraft>): StepDraft? =
	everyStep(steps).firstOrNull { step -> !(step is StepDraft.Do && step.action is ActionDraft.Filled) }

/** Statements need functions. */
private fun flatIssue(steps: List<StepDraft>, offer: AutomationOffer): RunsIssue? {
	if (offer.functions == null || flatActions(steps, offer) != null) return null
	if (!unnamedServed(offer)) notPlain(steps)?.let { return RunsIssue.NeedsName(it.key) }
	return unwritable(steps, offer, emptyList())?.let { RunsIssue.NotAStep(it.key) }
}

internal fun calleeIssue(callee: CalleeDraft, offer: AutomationOffer): RunsIssue? = when {
	callee.steps.isEmpty() -> RunsIssue.NoSteps
	else -> unwritable(callee.steps, offer, callee.params)?.let { RunsIssue.NotAStep(it.key) }
}

/** Unwritable, not merely broken. */
private fun unwritable(steps: List<StepDraft>, offer: AutomationOffer, params: List<FunctionValueDraft>): StepDraft? =
	everyStep(steps).firstOrNull { step ->
		when (step) {
			is StepDraft.Do -> stepOf(step.action, offer, params) == null
			is StepDraft.Call -> step.function.isBlank()
			is StepDraft.If, is StepDraft.Try, is StepDraft.Switch, is StepDraft.Wait, is StepDraft.Exit, is StepDraft.Note, is StepDraft.Kept -> false
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

internal fun runsIssue(runs: RunsDraft, selfId: String, given: TriggerGiven, offer: AutomationOffer): RunsIssue? =
	when (runs) {
		is RunsDraft.Kept -> null
		is RunsDraft.Flat -> if (runs.steps.isEmpty()) RunsIssue.NoSteps else flatIssue(runs.steps, offer)
		is RunsDraft.Pointing -> if (runs.steps.isEmpty()) RunsIssue.NoSteps else pointingIssue(runs, selfId, given, offer)
	}

/** Named-function value guidance. */
internal fun runsNote(runs: RunsDraft, given: TriggerGiven, offer: AutomationOffer): RunsNote? {
	val pointing = runs as? RunsDraft.Pointing ?: return null
	if (pointing.name.isBlank()) return null
	for (row in valueRows(pointing.wireParams(), given, pointing.valuesByName(), measure = null)) {
		val param = row.param ?: continue
		when (val source = row.source) {
			ValueSource.FromTrigger, is ValueSource.Mismatch -> Unit
			ValueSource.Unset -> return RunsNote.Unset(param.name)
			is ValueSource.Set -> valueIssue(param, source.text, offer)?.let { return RunsNote.BadValue(param.name, it) }
		}
	}
	return null
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
		val values = runs.params.isNotEmpty() || doings(runs.steps).any { (it.action as? ActionDraft.Filled)?.references?.isNotEmpty() == true }
		if (values && !unnamedServed(offer)) return RunsIssue.NameWithValues
		if (!unnamedServed(offer)) return notPlain(runs.steps)?.let { RunsIssue.NotAStep(it.key) }
		return unwritable(runs.steps, offer, runs.params)?.let { RunsIssue.NotAStep(it.key) }
	}
	nameIssue(runs.name)?.let { return it }
	val wireParams = runs.wireParams()
	unwritable(runs.steps, offer, runs.params)?.let { return RunsIssue.NotAStep(it.key) }
	if (runs.params.size > Protocol.Wire.FUNCTION_PARAMS_MAX) return RunsIssue.TooManyParams
	val paramIssues = paramIssues(wireParams, given)
	paramIssues.forEachIndexed { index, issue -> if (issue != null) return RunsIssue.BadParam(wireParams.getOrNull(index)?.name.orEmpty(), issue) }
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
	/** Named, or unnamed where held. */
	val valuesAllowed: Boolean = false,
	/** Pre-check guidance. */
	val note: RunsNote? = null,
	val issues: List<CardIssue> = emptyList(),
) {
	/** No empty header. */
	val reachHeader: Boolean get() = reach.isNotEmpty()
}

internal fun canAddValue(view: RunsView): Boolean =
	!view.kept && view.valuesAllowed && view.values.count { it.param != null } < Protocol.Wire.FUNCTION_PARAMS_MAX

/** Empty bodies stay cardless. */
private fun blockIssue(issue: RunsIssue?): RunsIssue? = when (issue) {
	null, RunsIssue.NoSteps -> null
	is RunsIssue.NotAStep,
	is RunsIssue.NeedsName,
	is RunsIssue.InCallee,
	RunsIssue.NameWithValues,
	is RunsIssue.BadParam,
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
	drawn: DrawnIssues? = null,
): RunsView? {
	val functions = offer.functions ?: return null
	val issue = blockIssue(draftRunsIssue(draft, fields, offer))
	val note = runsNote(draft.runsDraft(), givenOf(draft, fields), offer).takeIf { drawn == null }
	val issues = drawn?.rest.orEmpty()
	return when (val runs = draft.runsDraft()) {
		is RunsDraft.Flat -> RunsView("", true, null, emptyList(), emptyList(), unique = false, makeUnique = false, kept = false, issue = issue, issues = issues)
		is RunsDraft.Kept -> RunsView("", false, null, emptyList(), emptyList(), unique = false, makeUnique = false, kept = true, issue = null, issues = issues)
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
				reach = if (shared && row != null) reachLine(row, draft.id, rows, functions.rows) else emptyList(),
				unique = runs.mode == PointMode.UNIQUE,
				makeUnique = shared,
				kept = false,
				issue = issue,
				invalid = row?.invalid,
				moved = movedFor(said, runs),
				valuesAllowed = runs.name.isNotBlank() || unnamedServed(offer),
				note = note,
				issues = issues,
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

	/** Unnamed automation function. */
	data class Own(val does: String) : FunctionLine
}

/** Null for an automation with its own steps. */
internal fun functionLine(row: AutomationRow, functions: List<AutomationFunctionRow>?, offer: AutomationOffer): FunctionLine? {
	val pointer = pointerOf(row.automation) ?: return null
	val held = functions?.firstOrNull { it.id == pointer } ?: return FunctionLine.Unlisted
	if (held.function.name.isBlank()) {
		return FunctionLine.Own(written(held.function).joinToString(" · ") { cardLabel(treeOf(it, offer), offer) })
	}
	return FunctionLine.Named(held.function.name, usersCount(held))
}

internal const val SCRIPT_ERRORS_LINE = "Its script has errors. It will not run."

internal fun rowErrorsLine(row: AutomationRow): String? =
	row.errors?.takeIf { it > 0 }?.let { if (it == 1L) "1 error" else "$it errors" }

internal fun rowScriptErrors(row: AutomationRow, served: Served): Boolean {
	val rows = when (served) {
		is Served.Known -> served.offer.functions?.rows
		is Served.Unknown -> null
	} ?: return false
	val pointer = pointerOf(row.automation) ?: return false
	val reached = reachOver(listOf(pointer)) { id -> rows.firstOrNull { it.id == id }?.let { callsOf(it.function) }.orEmpty() }
	return rows.any { it.id in reached && written(it.function).singleOrNull() is FunctionStep.Unparsed }
}

/** Null where functions are not served or it runs its own steps. */
internal fun rowFunction(row: AutomationRow, served: Served): FunctionLine? = when (served) {
	is Served.Known -> served.offer.functions?.let { functionLine(row, it.rows, served.offer) }
	is Served.Unknown -> null
}

/** Shown only above one. */
internal fun usersCount(function: AutomationFunctionRow): Int? = function.users.size.takeIf { it > 1 }

/** Who else an edit reaches, by their sentences. */
internal fun reachLine(
	function: AutomationFunctionRow,
	selfId: String,
	rows: List<AutomationRow>,
	functions: List<AutomationFunctionRow> = emptyList(),
): List<String> =
	function.users.filter { it != selfId }.mapNotNull { id -> rows.firstOrNull { it.id == id }?.sentence } +
		function.callers.orEmpty().map { id -> "Called by ${functions.firstOrNull { it.id == id }?.function?.name?.ifBlank { null } ?: id}" }

/** The function a delete takes with it, by name. */
internal fun automationDeleteTakes(row: AutomationRow, functions: List<AutomationFunctionRow>?): String? {
	val pointer = pointerOf(row.automation) ?: return null
	return functions?.firstOrNull { it.id == pointer }?.takeIf { it.users == listOf(row.id) && it.callers.isNullOrEmpty() }?.function?.name
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
		.filter { row -> row.function.name.isNotBlank() }
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
	data class Stored(
		val automation: AutomationRow?,
		val function: AutomationFunctionRow?,
		val issues: List<AutomationIssue> = emptyList(),
	) : SaveAnswer

	/** Ask once, then send with `confirmed`. */
	data class Confirm(val labels: List<String>) : SaveAnswer

	/** Lands on its field. */
	data class Hole(
		val record: AutomationSaveRecord?,
		val path: String?,
		val param: String?,
		val start: Long?,
		val end: Long?,
		/** Called function ID. */
		val id: String? = null,
	) : SaveAnswer

	/** `code` null for one this build does not know. */
	data class Refused(val code: AutomationSaveRefusalCode?, val refusal: AutomationSaveRefusal) : SaveAnswer
}

/** The function it points at. */
internal fun pointerOf(automation: Automation): String? = (written(automation).singleOrNull() as? AutomationAction.RunFunction)?.function

/** Where a refusal lands, as the Gateway names it; the editor maps a step's path to its card. */
internal sealed interface RefusedAt {
	data class Value(val param: String) : RefusedAt

	/** `null` means own function. */
	data class Step(val path: String, val param: String, val function: String? = null) : RefusedAt
}

/** Hole path and function. */
internal data class RefusedHole(val path: String, val param: String, val start: Int, val end: Int, val function: String? = null)

// skew:step-refusals
internal fun refusedHoleOf(hole: SaveAnswer.Hole): RefusedHole? {
	val path = hole.path?.takeIf { it.isNotEmpty() } ?: return null
	return RefusedHole(path, hole.param ?: return null, hole.start?.toInt() ?: return null, hole.end?.toInt() ?: return null, hole.id)
}

/** An older put names its action by index. */
internal fun refusedHoleOf(span: AutomationHoleSpan): RefusedHole =
	RefusedHole("${span.action}", span.param, span.start.toInt(), span.end.toInt())

// skew:step-refusals
/** A row or field it names. */
internal fun refusedAtOf(refusal: AutomationSaveRefusal): RefusedAt? {
	if (refusal.code != AutomationSaveRefusalCode.INVALID.wire) return null
	val step = refusal.step
	val param = refusal.param
	val function = refusal.id.takeIf { refusal.record == AutomationSaveRecord.FUNCTION.wire }
	if (step != null && param != null) return RefusedAt.Step(step, param, function)
	val parts = refusal.path?.split(".") ?: return null
	return when {
		parts.size == 2 && parts[0] == VALUES -> RefusedAt.Value(parts[1])
		parts.size == 3 && parts[0] == STEPS -> parts[1].takeIf { it.toIntOrNull() != null }?.let { RefusedAt.Step(it, parts[2], function) }
		else -> null
	}
}

private const val VALUES = "values"

private const val STEPS = "steps"

/** Only the automation's own move offers its row. */
internal fun movedAutomation(refused: SaveAnswer.Refused): Boolean =
	refused.code == AutomationSaveRefusalCode.MOVED && refused.refusal.record == AutomationSaveRecord.AUTOMATION.wire

internal fun saveAnswerOf(result: ConsoleAutomationSaveResult): SaveAnswer {
	if (result.stored) return SaveAnswer.Stored(result.automation, result.function, result.issues.orEmpty())
	val refusal = result.refusal ?: return SaveAnswer.Refused(null, AutomationSaveRefusal(code = ""))
	val code = AutomationSaveRefusalCode.entries.find { it.wire == refusal.code } ?: return SaveAnswer.Refused(null, refusal)
	return when (code) {
		AutomationSaveRefusalCode.CONFIRM -> SaveAnswer.Confirm(refusal.labels.orEmpty())
		// skew:step-refusals
		AutomationSaveRefusalCode.HOLE -> SaveAnswer.Hole(
			refusal.record?.let { word -> AutomationSaveRecord.entries.find { it.wire == word } },
			refusal.path,
			refusal.param,
			refusal.start,
			refusal.end,
			refusal.id.takeIf { refusal.record == AutomationSaveRecord.FUNCTION.wire },
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

/** Undeclared values; none while unknown. */
internal fun strayCallValues(step: StepDraft.Call, params: List<FunctionParam>?): List<String> {
	val declared = params?.map { it.name }?.toSet() ?: return emptyList()
	return step.values.keys.filter { it !in declared }
}
