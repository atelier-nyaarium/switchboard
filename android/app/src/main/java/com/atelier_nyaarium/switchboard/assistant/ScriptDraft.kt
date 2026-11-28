package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.ConsoleOp
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptParseResult
import com.atelier_nyaarium.switchboard.proto.ConsoleScriptPrintResult
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.ScriptFunction
import com.atelier_nyaarium.switchboard.proto.ScriptIssue
import com.atelier_nyaarium.switchboard.proto.ScriptName
import com.atelier_nyaarium.switchboard.proto.ScriptStatement
import com.atelier_nyaarium.switchboard.proto.ScriptType
import com.atelier_nyaarium.switchboard.liveconsole.ConsoleTokenKind
import com.atelier_nyaarium.switchboard.liveconsole.VariableShape
import com.atelier_nyaarium.switchboard.liveconsole.lexScript

internal data class ScriptEdit(
	val text: String,
	/** Opening text. */
	val from: String,
	/** Opening cards. */
	val cards: List<StepDraft>,
	/** Last parse request. */
	val parsed: ConsoleOp.ScriptParse? = null,
	val answer: ConsoleScriptParseResult? = null,
	/** Latest completion names. */
	val names: List<ScriptName> = emptyList(),
	val types: List<ScriptType> = emptyList(),
	/** A parse that got no answer. */
	val failed: ConsoleOp.ScriptParse? = null,
) {
	fun typed(): Boolean = text != from

	/** Typed text awaits parsing. */
	fun unread(): Boolean = typed() && parsed?.text != text
}

/** Null tree: its own; `at`: the cursor. */
internal data class ScriptPage(val tree: String?, val at: Int? = null, val jumps: Int = 0)

internal fun scriptServed(offer: AutomationOffer): Boolean = offer.functions?.served?.script == true

internal fun unparsedServed(offer: AutomationOffer): Boolean = offer.functions?.served?.statements.orEmpty().contains(UNPARSED)

private const val UNPARSED = "unparsed"

/** Single-card unparsed errors. */
internal fun holdsErrors(cards: List<StepDraft>): Boolean =
	(cards.singleOrNull() as? StepDraft.ScriptOnly)?.step is FunctionStep.Unparsed

/** Stored errors open as text. */
internal fun scriptOfCards(cards: List<StepDraft>): ScriptEdit? {
	val source = ((cards.singleOrNull() as? StepDraft.ScriptOnly)?.step as? FunctionStep.Unparsed)?.source ?: return null
	return ScriptEdit(source, source, cards)
}

internal fun AutomationDraft.scriptOf(tree: String?): ScriptEdit? = if (tree == null) script else callees[tree]?.script

internal fun AutomationDraft.scriptedOf(tree: String?): Boolean =
	if (tree == null) scripted else callees[tree]?.scripted == true

private fun AutomationDraft.paramsOf(tree: String?): List<FunctionParamDraft> =
	if (tree == null) (runs as? RunsHead.Points)?.pointing?.params.orEmpty() else callees[tree]?.params.orEmpty()

private fun AutomationDraft.withScriptOf(tree: String?, edit: ScriptEdit?, scripted: Boolean, cards: List<StepDraft>? = null): AutomationDraft {
	if (tree == null) return copy(script = edit, scripted = scripted, steps = cards ?: steps)
	val held = callees[tree] ?: return this
	return copy(callees = callees + (tree to held.copy(script = edit, scripted = scripted, steps = cards ?: held.steps)))
}

internal fun AutomationDraft.scriptTrees(): List<String?> =
	(if (script != null) listOf<String?>(null) else emptyList()) + callees.values.filter { it.script != null }.map { it.id }

internal fun scriptFunctionsOf(draft: AutomationDraft): List<ScriptFunction> {
	val own = (draft.runs as? RunsHead.Points)?.pointing
		?.takeIf { it.name.isNotBlank() }
		?.let { ScriptFunction(it.functionId, it.name.trim(), it.wireParams()) }
	val called = draft.callees.values
		.filter { it.name.isNotBlank() }
		.map { ScriptFunction(it.id, it.name.trim(), it.params.map { value -> value.param }) }
	return listOfNotNull(own) + called
}

private fun AutomationDraft.wireParamsOf(tree: String?): List<FunctionParam> =
	paramsOf(tree).map { it.param }.filter { it.name.isNotBlank() }

internal fun scriptPrintOp(draft: AutomationDraft, tree: String?, offer: AutomationOffer): ConsoleOp.ScriptPrint? {
	if (draft.scriptOf(tree) != null) return null
	val params = draft.paramsOf(tree)
	val steps = draft.stepsOf(tree).map { stepOfDraft(it, offer, params, calleeParamsOf(draft, offer)) ?: return null }
	return ConsoleOp.ScriptPrint(
		steps = steps,
		trigger = draft.builtTrigger(offer),
		params = draft.wireParamsOf(tree).takeIf { it.isNotEmpty() },
		functions = scriptFunctionsOf(draft).takeIf { it.isNotEmpty() },
	)
}

internal fun scriptParseOp(draft: AutomationDraft, tree: String?, offer: AutomationOffer): ConsoleOp.ScriptParse? {
	val edit = draft.scriptOf(tree) ?: return null
	return ConsoleOp.ScriptParse(
		text = edit.text,
		trigger = draft.builtTrigger(offer),
		params = draft.wireParamsOf(tree).takeIf { it.isNotEmpty() },
		functions = scriptFunctionsOf(draft).takeIf { it.isNotEmpty() },
	)
}

internal fun AutomationDraft.startedScript(
	tree: String?,
	shown: String,
	names: List<ScriptName> = emptyList(),
	types: List<ScriptType> = emptyList(),
	at: Int? = null,
): AutomationDraft {
	val held = scriptOf(tree)
	val edit = held ?: ScriptEdit(shown, shown, stepsOf(tree), names = names, types = types)
	return withScriptOf(tree, edit, scripted = true).copy(scriptPage = ScriptPage(tree, at))
}

internal fun AutomationDraft.typedScript(tree: String?, text: String): AutomationDraft {
	val edit = scriptOf(tree) ?: return this
	return withScriptOf(tree, edit.copy(text = text), scripted = true)
}

/** Ignore stale parse answers. */
internal fun AutomationDraft.parsedInto(
	tree: String?,
	asked: ConsoleOp.ScriptParse,
	answer: ConsoleScriptParseResult,
	offer: AutomationOffer,
): AutomationDraft {
	val edit = scriptOf(tree) ?: return this
	if (asked != scriptParseOp(this, tree, offer)) return this
	val params = paramsOf(tree)
	val cards = answer.steps?.map { treeOf(it, offer, params) } ?: listOf(StepDraft.ScriptOnly(freshKey(), FunctionStep.Unparsed(edit.text)))
	val read = edit.copy(parsed = asked, answer = answer, names = answer.names, types = answer.types)
	val landed = withScriptOf(tree, read, scripted = true, cards = cards)
	// Non-flat script needs function.
	return if (tree == null && runs == RunsHead.Unnamed && flatActions(cards, offer) == null) {
		landed.copy(newFunctionId = newFunctionId ?: freshFunctionId())
	} else landed
}

/** No answer came; held until Retry. */
internal fun AutomationDraft.parseFailed(tree: String?, asked: ConsoleOp.ScriptParse, offer: AutomationOffer): AutomationDraft {
	val edit = scriptOf(tree) ?: return this
	if (asked != scriptParseOp(this, tree, offer)) return this
	return withScriptOf(tree, edit.copy(failed = asked), scripted = scriptedOf(tree))
}

internal fun AutomationDraft.parseRetried(tree: String?): AutomationDraft {
	val edit = scriptOf(tree) ?: return this
	return withScriptOf(tree, edit.copy(failed = null), scripted = scriptedOf(tree))
}

/** The parse to send now; null when answered, failed or over the cap. */
internal fun parseToSend(draft: AutomationDraft, tree: String?, offer: AutomationOffer): ConsoleOp.ScriptParse? {
	val op = scriptParseOp(draft, tree, offer) ?: return null
	val edit = draft.scriptOf(tree) ?: return null
	if (edit.parsed == op || edit.failed == op || op.text.length > Protocol.Wire.SCRIPT_SOURCE_MAX) return null
	return op
}

internal fun AutomationDraft.discardedScript(tree: String?): AutomationDraft {
	val edit = scriptOf(tree) ?: return this
	val restored = scriptOfCards(edit.cards)
	return withScriptOf(tree, restored, scripted = restored != null || scriptedOf(tree), cards = edit.cards)
}

internal fun AutomationDraft.shownAs(tree: String?, script: Boolean, offer: AutomationOffer): AutomationDraft {
	if (script) return withScriptOf(tree, scriptOf(tree), scripted = true)
	if (!cardsAllowed(this, tree, offer)) return this
	return withScriptOf(tree, null, scripted = false)
}

/** Answer fits text and context. */
internal fun scriptCurrent(draft: AutomationDraft, tree: String?, offer: AutomationOffer): Boolean {
	val edit = draft.scriptOf(tree) ?: return false
	return edit.parsed != null && edit.parsed == scriptParseOp(draft, tree, offer)
}

/** Require current parse. */
internal fun cardsAllowed(draft: AutomationDraft, tree: String?, offer: AutomationOffer): Boolean {
	val edit = draft.scriptOf(tree) ?: return true
	return scriptCurrent(draft, tree, offer) && edit.answer?.steps != null
}

/** A parse is out. */
internal fun scriptPending(draft: AutomationDraft, offer: AutomationOffer): Boolean =
	draft.scriptTrees().any { tree -> draft.scriptOf(tree)?.parsed != scriptParseOp(draft, tree, offer) }

/** Ignore stale issues. */
internal fun scriptIssues(draft: AutomationDraft, tree: String?, offer: AutomationOffer): List<ScriptIssue> =
	draft.scriptOf(tree)?.answer?.takeIf { scriptCurrent(draft, tree, offer) }?.issues.orEmpty()

internal fun markedIssue(issues: List<ScriptIssue>): ScriptIssue? = issues.firstOrNull { drawsAsError(issueLevelOf(it.level)) }

/** Confirm newly introduced errors. */
internal data class ErrorsAsk(
	/** Functions newly holding errors. */
	val functions: List<String>,
	/** Others that run them. */
	val others: List<String>,
)

internal fun errorsAsk(draft: AutomationDraft, offer: AutomationOffer, rows: List<AutomationRow> = emptyList()): ErrorsAsk? {
	val asked = mutableListOf<String>()
	val others = mutableListOf<String>()
	val pointing = (draft.runs as? RunsHead.Points)?.pointing
	val storedRoot = pointing?.original?.let { holdsErrorSteps(written(it)) } ?: false
	if (holdsErrors(draft.steps) && !storedRoot) {
		asked += pointing?.name?.takeIf { it.isNotBlank() } ?: UNNAMED_FUNCTION
		// Copies retain original users.
		pointing?.takeIf { it.mode == PointMode.SHARED }?.let { others += alsoRunBy(draft, offer, rows, it.functionId) }
	}
	for (callee in sentCallees(draft, offer)) {
		val stored = callee.original?.let { holdsErrorSteps(written(it)) } ?: false
		if (holdsErrors(callee.steps) && !stored) {
			asked += callee.name
			others += alsoRunBy(draft, offer, rows, callee.id)
		}
	}
	return asked.takeIf { it.isNotEmpty() }?.let { ErrorsAsk(it, others.distinct()) }
}

private fun holdsErrorSteps(steps: List<FunctionStep>): Boolean = steps.singleOrNull() is FunctionStep.Unparsed

/** This Gateway cannot hold a script with errors. */
internal fun errorsRefused(draft: AutomationDraft, offer: AutomationOffer): Boolean {
	if (unparsedServed(offer)) return false
	return holdsErrors(draft.steps) || sentCallees(draft, offer).any { holdsErrors(it.steps) }
}

internal const val UNNAMED_FUNCTION = "Unnamed function"

internal enum class LineMark { UNREACHED, DONE, UNSURE, FAILED, RUNNING }

internal data class ScriptLine(
	val start: Int,
	val end: Int,
	val mark: LineMark?,
	val said: String?,
)

private val CASE_WORDS = setOf("case", "default")

private fun lineBounds(text: String): List<Pair<Int, Int>> {
	var start = 0
	return text.split("\n").map { line -> (start to start + line.length).also { start += line.length + 1 } }
}

private fun caseStarts(text: String): List<Int> {
	val tokens = lexScript(text).filter { it.kind != ConsoleTokenKind.COMMENT }
	return tokens.filterIndexed { at, token ->
		token.kind == ConsoleTokenKind.IDENT && token.text in CASE_WORDS && (at == 0 || tokens[at - 1].kind == ConsoleTokenKind.NEWLINE)
	}.map { it.start }
}

/** Case lines by switch. */
private fun caseHeads(text: String, bounds: List<Pair<Int, Int>>, statements: List<ScriptStatement>): Map<Int, Pair<ScriptStatement, Int>> {
	val counts = mutableMapOf<ScriptStatement, Int>()
	val starts = caseStarts(text)
	return bounds.withIndex().mapNotNull { (at, bound) ->
		val (start, end) = bound
		if (starts.none { it in start..end }) return@mapNotNull null
		val owner = statements.filter { it.start.toInt() <= start && it.end.toInt() >= end }.maxByOrNull { it.start } ?: return@mapNotNull null
		val number = counts.getOrDefault(owner, 0)
		counts[owner] = number + 1
		at to (owner to number)
	}.toMap()
}

internal fun scriptLines(text: String, statements: List<ScriptStatement>, lastRun: AutomationLastRun?, pointing: Boolean): List<ScriptLine> {
	val last = lastRun?.steps.orEmpty().associateBy { it.path }
	val now = if (lastRun?.running == true) listOfNotNull(lastRun.active).toSet() + lastRun.inFlight.orEmpty() else emptySet()
	val bounds = lineBounds(text)
	val heads = caseHeads(text, bounds, statements)
	return bounds.mapIndexed { at, (start, end) ->
		val opened = statements.firstOrNull { it.start.toInt() in start..end }
		val head = heads[at]?.takeIf { opened == null }
		val taken = head?.let { (owner, _) -> last[runPathOf(owner.step, pointing)]?.case }
		if (lastRun != null && head != null && taken != null) {
			return@mapIndexed ScriptLine(start, end, if (taken.toInt() == head.second) LineMark.DONE else LineMark.UNREACHED, null)
		}
		val run = opened?.let { runPathOf(it.step, pointing) }
		val step = run?.let { last[it] }
		val mark = when {
			lastRun == null || run == null -> null
			run in now -> LineMark.RUNNING
			step == null -> LineMark.UNREACHED
			else -> when (Protocol.Wire.RunOutcome.entries.find { it.wire == step.outcome }) {
				null -> LineMark.RUNNING
				Protocol.Wire.RunOutcome.DONE -> LineMark.DONE
				Protocol.Wire.RunOutcome.FAILED -> LineMark.FAILED
				Protocol.Wire.RunOutcome.UNSURE, Protocol.Wire.RunOutcome.SKIPPED -> LineMark.UNSURE
			}
		}
		ScriptLine(start, end, mark, step?.reason?.takeIf { mark == LineMark.FAILED })
	}
}

internal fun scriptNamesHere(given: List<NameHere>, names: List<ScriptName>): List<NameHere> {
	val held = given.map { it.name }.toSet()
	return given + names.distinctBy { it.name }.filter { it.name !in held }.map { NameHere(it.name, it.type, null) }
}

internal fun namesAt(names: List<ScriptName>, cursor: Int): List<ScriptName> =
	names.filter { cursor.toLong() in it.start..it.end }

internal fun scriptParamsOf(draft: AutomationDraft, tree: String?): List<FunctionParam> = draft.wireParamsOf(tree)

/** Nearest name wins. */
internal fun scriptShapes(names: List<ScriptName>, types: List<ScriptType>, cursor: Int): Map<String, VariableShape?> {
	val members = types.associate { type -> type.name to type.members.map { it.name } }
	return namesAt(names, cursor).sortedBy { it.start }.associate { name -> name.name to members[name.type]?.let { VariableShape(it, list = false) } }
}

internal data class ScriptSignature(val name: String?, val params: List<String>, val given: List<String>)

internal fun scriptSignature(draft: AutomationDraft, tree: String?, offer: AutomationOffer): ScriptSignature {
	val name = if (tree == null) (draft.runs as? RunsHead.Points)?.pointing?.name else draft.callees[tree]?.name
	val params = draft.wireParamsOf(tree).map { "${it.name}: ${it.type.replaceFirstChar { first -> first.uppercase() }}" }
	val given = offer.names(draft.trigger.kind).map { it.name }
	return ScriptSignature(name?.takeIf { it.isNotBlank() }, params, given)
}

internal fun errorsLine(ask: ErrorsAsk): String {
	val also = ask.others.takeIf { it.isNotEmpty() }?.let { " Also run by: ${it.joinToString(", ")}." }.orEmpty()
	return "${ask.functions.joinToString(", ")} will not run until its errors are fixed.$also"
}

internal data class ScriptOnlyLine(val text: String, val at: Int)

internal fun scriptOnlyLines(cards: List<StepDraft>, print: ConsoleScriptPrintResult?): Map<String, ScriptOnlyLine> {
	val answer = print?.takeIf { it.text.isNotEmpty() } ?: return emptyMap()
	val spans = answer.statements.associateBy { it.step }
	return pathsOf(cards).mapNotNull { (key, path) ->
		if (findStep(cards, key) !is StepDraft.ScriptOnly) return@mapNotNull null
		val span = spans[path] ?: return@mapNotNull null
		val start = span.start.toInt().coerceIn(0, answer.text.length)
		val end = span.end.toInt().coerceIn(start, answer.text.length)
		key to ScriptOnlyLine(answer.text.substring(start, end).lineSequence().first().trim(), start)
	}.toMap()
}

internal fun showsScript(draft: AutomationDraft, tree: String?, offer: AutomationOffer): Boolean =
	draft.scriptedOf(tree) && scriptServed(offer)

internal sealed interface ScriptShown {
	data object Reading : ScriptShown

	data object Unread : ScriptShown

	data object Unwritable : ScriptShown

	data class Text(
		val text: String,
		val statements: List<ScriptStatement>,
		val names: Set<String>,
		val issues: List<ScriptIssue>,
		/** Read-only reason. */
		val readOnly: String?,
		val errors: Boolean,
		val checking: Boolean,
		/** Stored errors parsed. */
		val fixed: Boolean,
		/** The last parse got no answer. */
		val failed: Boolean,
		val tooLong: Boolean,
		val discard: Boolean,
		val editable: Boolean,
	) : ScriptShown
}

internal fun scriptShown(
	draft: AutomationDraft,
	tree: String?,
	offer: AutomationOffer,
	print: ConsoleScriptPrintResult?,
	printFailed: Boolean,
): ScriptShown {
	val typed = draft.scriptOf(tree)
	val text = typed?.text ?: print?.text
	if (text == null) {
		return when {
			printFailed -> ScriptShown.Unread
			typed == null && scriptPrintOp(draft, tree, offer) == null -> ScriptShown.Unwritable
			else -> ScriptShown.Reading
		}
	}
	val current = scriptCurrent(draft, tree, offer)
	val cards = draft.stepsOf(tree)
	val readOnly = print?.readOnly?.takeIf { typed == null }
	return ScriptShown.Text(
		text = text,
		statements = if (typed == null) print?.statements.orEmpty() else typed.answer?.statements?.takeIf { current }.orEmpty(),
		names = (typed?.names ?: print?.names.orEmpty()).map { it.name }.toSet(),
		issues = scriptIssues(draft, tree, offer),
		readOnly = readOnly,
		errors = holdsErrors(cards),
		checking = typed != null && !current && typed.failed == null && text.length <= Protocol.Wire.SCRIPT_SOURCE_MAX,
		fixed = typed != null && current && holdsErrors(typed.cards) && !holdsErrors(cards),
		failed = typed?.failed != null && typed.failed == scriptParseOp(draft, tree, offer),
		tooLong = text.length > Protocol.Wire.SCRIPT_SOURCE_MAX,
		discard = typed != null && (typed.typed() || unkeyed(typed.cards) != unkeyed(cards)),
		editable = typed != null || readOnly == null,
	)
}

/** Moves the editor's cursor, again for the same place. */
internal fun AutomationDraft.jumpedTo(at: Int): AutomationDraft =
	copy(scriptPage = scriptPage?.let { it.copy(at = at, jumps = it.jumps + 1) })
