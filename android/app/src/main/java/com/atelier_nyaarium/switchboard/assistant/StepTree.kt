package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.liveconsole.quoteConsoleString
import com.atelier_nyaarium.switchboard.parseDecimal
import com.atelier_nyaarium.switchboard.proto.AssistantFieldOption
import com.atelier_nyaarium.switchboard.proto.FunctionParam
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.FunctionParamType
import com.atelier_nyaarium.switchboard.proto.StepArg
import com.atelier_nyaarium.switchboard.proto.SwitchCase
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.util.UUID

/** A step as the editor holds it, named by a key minted once. */
internal sealed interface StepDraft {
	val key: String

	data class Action(override val key: String, val action: ActionDraft) : StepDraft

	data class If(
		override val key: String,
		/** One expression, as typed. */
		val condition: String,
		val then: List<StepDraft>,
		val elseSteps: List<StepDraft>,
	) : StepDraft

	data class Try(override val key: String, val body: List<StepDraft>, val catch: List<StepDraft>) : StepDraft

	data class Switch(
		override val key: String,
		/** One expression, as typed. */
		val subject: String,
		val cases: List<CaseDraft>,
		val default: List<StepDraft>,
	) : StepDraft

	/** Minutes as typed. */
	data class Wait(override val key: String, val minutes: String) : StepDraft

	data class Return(override val key: String) : StepDraft

	data class Comment(override val key: String, val text: String) : StepDraft

	/** Arguments by the function's parameter names. */
	data class RunFunction(override val key: String, val function: String, val args: Map<String, FunctionArg>) : StepDraft

	/** Value as typed; `read` is written back while the field still shows it. */
	data class Variable(override val key: String, val name: String, val value: String, val read: StepArg? = null) : StepDraft

	/** One step per branch. */
	data class Parallel(override val key: String, val branches: List<StepDraft>) : StepDraft

	/** Blank name: none. */
	data class Start(override val key: String, val name: String, val steps: List<StepDraft>) : StepDraft

	/** Task as an expression; blank name: no result. */
	data class Await(override val key: String, val task: String, val name: String) : StepDraft

	/** Null: no message. */
	data class Throw(override val key: String, val text: String?) : StepDraft

	/** Drawn as its script line, written back as it was read. */
	data class ScriptOnly(override val key: String, val step: FunctionStep) : StepDraft
}

/** Key minted once. */
internal data class CaseDraft(val key: String, val values: List<String>, val steps: List<StepDraft>)

/** Null when unknown. */
internal typealias CalleeParams = (String) -> List<FunctionParam>?

/** Typed literal, or an expression read in scope. */
internal sealed interface FunctionArg {
	data class Typed(val text: String) : FunctionArg

	data class Read(val expression: String) : FunctionArg
}

/** Where a new step lands: an index in the top list, or in a step's side. */
internal data class Slot(val parent: String?, val side: Side?, val index: Int)

internal val STEPS_PER_LIST = Protocol.Wire.FUNCTION_STEPS_MAX
internal val STEPS_TOTAL = Protocol.Wire.FUNCTION_STEPS_TOTAL_MAX

/** Numbered sides, in order. */
internal fun sidesOf(step: StepDraft): List<Pair<Side, List<StepDraft>>> = when (step) {
	is StepDraft.If -> listOf(Side.Then to step.then, Side.Else to step.elseSteps)
	is StepDraft.Try -> listOf(Side.Body to step.body, Side.Catch to step.catch)
	is StepDraft.Switch ->
		step.cases.mapIndexed { at, held -> Side.Case(at) to held.steps } + (Side.Default(step.cases.size) to step.default)
	is StepDraft.Parallel -> listOf(Side.Body to step.branches)
	is StepDraft.Start -> listOf(Side.Body to step.steps)
	is StepDraft.Action, is StepDraft.Wait, is StepDraft.Return, is StepDraft.Comment, is StepDraft.RunFunction,
	is StepDraft.Variable, is StepDraft.Await, is StepDraft.Throw, is StepDraft.ScriptOnly -> emptyList()
}

private fun withSide(step: StepDraft, side: Side, list: List<StepDraft>): StepDraft = when (step) {
	is StepDraft.If -> when (side) {
		Side.Then -> step.copy(then = list)
		Side.Else -> step.copy(elseSteps = list)
		Side.Body, Side.Catch, is Side.Case, is Side.Default -> step
	}
	is StepDraft.Try -> when (side) {
		Side.Body -> step.copy(body = list)
		Side.Catch -> step.copy(catch = list)
		Side.Then, Side.Else, is Side.Case, is Side.Default -> step
	}
	is StepDraft.Switch -> when (side) {
		is Side.Case -> step.copy(cases = step.cases.mapIndexed { at, held -> if (at == side.index) held.copy(steps = list) else held })
		is Side.Default -> step.copy(default = list)
		Side.Then, Side.Else, Side.Body, Side.Catch -> step
	}
	is StepDraft.Parallel -> if (side == Side.Body) step.copy(branches = list) else step
	is StepDraft.Start -> if (side == Side.Body) step.copy(steps = list) else step
	is StepDraft.Action, is StepDraft.Wait, is StepDraft.Return, is StepDraft.Comment, is StepDraft.RunFunction,
	is StepDraft.Variable, is StepDraft.Await, is StepDraft.Throw, is StepDraft.ScriptOnly -> step
}

/** Side edits preserve keys. */
private fun withSidesMapped(step: StepDraft, change: (List<StepDraft>) -> List<StepDraft>): StepDraft =
	sidesOf(step).fold(step) { held, (side, list) -> withSide(held, side, change(list)) }

/** Every step at every depth, a step before what it holds. */
internal fun everyStep(steps: List<StepDraft>): List<StepDraft> =
	steps.flatMap { step -> listOf(step) + sidesOf(step).flatMap { (_, list) -> everyStep(list) } }

internal fun findStep(steps: List<StepDraft>, key: String): StepDraft? = everyStep(steps).firstOrNull { it.key == key }

/** Else-if links, in order. */
internal fun chainOf(step: StepDraft.If): List<StepDraft.If> =
	generateSequence(step) { it.elseSteps.singleOrNull() as? StepDraft.If }.toList()

/** Ifs drawn as else-if links. */
internal fun linkKeys(steps: List<StepDraft>): Set<String> =
	everyStep(steps).mapNotNull { ((it as? StepDraft.If)?.elseSteps?.singleOrNull() as? StepDraft.If)?.key }.toSet()

/** Null where caps refuse. */
internal fun withElseIf(steps: List<StepDraft>, head: String): List<StepDraft>? {
	val last = (findStep(steps, head) as? StepDraft.If)?.let { chainOf(it).last() } ?: return null
	val link = StepDraft.If(freshKey(), "", emptyList(), last.elseSteps)
	return replacedStep(steps, last.key) { last.copy(elseSteps = listOf(link)) }.takeIf(::fits)
}

/** Previous link takes else. */
internal fun withoutLink(steps: List<StepDraft>, link: String): List<StepDraft> {
	val before = everyStep(steps).filterIsInstance<StepDraft.If>().firstOrNull { it.elseSteps.singleOrNull()?.key == link } ?: return steps
	val dropped = before.elseSteps.single() as? StepDraft.If ?: return steps
	return replacedStep(steps, before.key) { before.copy(elseSteps = dropped.elseSteps) }
}

private fun fits(steps: List<StepDraft>): Boolean {
	val lists = listOf(steps) + everyStep(steps).flatMap { step -> sidesOf(step).map { it.second } }
	return lists.all { it.size <= STEPS_PER_LIST } && everyStep(steps).size <= STEPS_TOTAL
}

/** The step at `key` changed; every other key unchanged. */
internal fun replacedStep(steps: List<StepDraft>, key: String, change: (StepDraft) -> StepDraft): List<StepDraft> =
	steps.map { step -> if (step.key == key) change(step) else withSidesMapped(step) { replacedStep(it, key, change) } }

internal fun removedStep(steps: List<StepDraft>, key: String): List<StepDraft> =
	steps.filter { it.key != key }.map { step -> withSidesMapped(step) { removedStep(it, key) } }

private fun placed(steps: List<StepDraft>, slot: Slot, step: StepDraft): List<StepDraft> {
	fun into(list: List<StepDraft>) = list.toMutableList().apply { add(slot.index.coerceIn(0, size), step) }
	if (slot.parent == null) return into(steps)
	val side = slot.side ?: return steps
	return replacedStep(steps, slot.parent) { held ->
		val list = sidesOf(held).firstOrNull { it.first == side }?.second ?: return@replacedStep held
		withSide(held, side, into(list))
	}
}

/** Null where a cap refuses it, or the slot is gone. */
internal fun insertedStep(steps: List<StepDraft>, slot: Slot, step: StepDraft): List<StepDraft>? {
	if (slot.parent != null && findStep(steps, slot.parent) == null) return null
	return placed(steps, slot, step).takeIf { fits(it) && everyStep(it).size == everyStep(steps).size + everyStep(listOf(step)).size }
}

/** Null where it would land inside itself, or a cap refuses it. */
internal fun movedStep(steps: List<StepDraft>, key: String, slot: Slot): List<StepDraft>? {
	val step = findStep(steps, key) ?: return null
	if (slot.parent != null && findStep(listOf(step), slot.parent) != null) return null
	return insertedStep(removedStep(steps, key), slot, step)
}

/** Relative sibling slot. */
internal fun shiftedSlot(steps: List<StepDraft>, key: String, delta: Int): Slot? {
	val (parent, side, list) = listHolding(steps, key) ?: return null
	val index = list.indexOfFirst { it.key == key } + delta
	return Slot(parent, side, index).takeIf { index in list.indices }
}

internal data class MoveChoice(val label: String, val slot: Slot)

/** Whether `moveChoices` can offer any. */
internal fun mayMove(steps: List<StepDraft>, key: String): Boolean {
	val (parent, _, list) = listHolding(steps, key) ?: return false
	return parent != null || list.size > 1
}

/** Only moves that land and leave every link a link. */
internal fun moveChoices(
	steps: List<StepDraft>,
	key: String,
	offer: AutomationOffer,
	choicesOf: (String) -> List<AssistantFieldOption>?,
): List<MoveChoice> {
	val (parent, _, list) = listHolding(steps, key) ?: return emptyList()
	val index = list.indexOfFirst { it.key == key }
	val shifts = listOfNotNull(
		shiftedSlot(steps, key, -1)?.let { MoveChoice("Move up", it) },
		shiftedSlot(steps, key, 1)?.let { MoveChoice("Move down", it) },
	)
	val into = list.getOrNull(index - 1)?.let { drawnSides(it, choicesOf) }.orEmpty().map { (label, slot) -> MoveChoice("Into $label above", slot) }
	val out = parent?.let { owner ->
		val container = drawnOwner(steps, owner)
		val (above, aboveSide, aboveList) = listHolding(steps, container) ?: return@let null
		val step = findStep(steps, container) ?: return@let null
		MoveChoice("Out of ${cardLabel(step, offer)}", Slot(above, aboveSide, aboveList.indexOfFirst { it.key == container } + 1))
	}
	val links = linkKeys(steps)
	return (shifts + into + listOfNotNull(out)).filter { choice -> movedStep(steps, key, choice.slot)?.let(::linkKeys) == links }
}

/** Sides as drawn, repeats numbered. */
private fun drawnSides(step: StepDraft, choicesOf: (String) -> List<AssistantFieldOption>?): List<Pair<String, Slot>> {
	val sides = when (step) {
		is StepDraft.If -> {
			val links = chainOf(step)
			val end = links.last()
			links.mapIndexed { at, link -> (if (at == 0) "If" else "Else if") to Slot(link.key, Side.Then, link.then.size) } +
				("Else" to Slot(end.key, Side.Else, end.elseSteps.size))
		}
		is StepDraft.Switch ->
			caseViews(step, choicesOf(step.subject)).mapIndexed { at, view ->
				listOfNotNull("Case", view.chips.firstOrNull()?.label).joinToString(" ") to Slot(step.key, Side.Case(at), view.case.steps.size)
			} + ("Default" to Slot(step.key, Side.Default(step.cases.size), step.default.size))
		is StepDraft.Try -> listOf("Try" to Slot(step.key, Side.Body, step.body.size), "Catch" to Slot(step.key, Side.Catch, step.catch.size))
		is StepDraft.Parallel -> listOf("Parallel" to Slot(step.key, Side.Body, step.branches.size))
		is StepDraft.Start -> listOf("Start task" to Slot(step.key, Side.Body, step.steps.size))
		is StepDraft.Action, is StepDraft.Wait, is StepDraft.Return, is StepDraft.Comment, is StepDraft.RunFunction,
		is StepDraft.Variable, is StepDraft.Await, is StepDraft.Throw, is StepDraft.ScriptOnly -> emptyList()
	}
	return numberedRepeats(sides.map { it.first }).zip(sides) { label, (_, slot) -> label to slot }
}

/** Repeated labels, numbered in order. */
private fun numberedRepeats(labels: List<String>): List<String> {
	val counts = labels.groupingBy { it }.eachCount()
	val seen = mutableMapOf<String, Int>()
	return labels.map { label ->
		if (counts.getValue(label) == 1) return@map label
		val number = (seen[label] ?: 0) + 1
		seen[label] = number
		"$label $number"
	}
}

/** Else-if chain heads. */
private fun drawnOwner(steps: List<StepDraft>, key: String): String {
	val links = linkKeys(steps)
	var at = key
	while (at in links) at = listHolding(steps, at)?.first ?: return at
	return at
}

private fun listHolding(steps: List<StepDraft>, key: String): Triple<String?, Side?, List<StepDraft>>? {
	if (steps.any { it.key == key }) return Triple(null, null, steps)
	for (step in everyStep(steps)) {
		for ((side, list) in sidesOf(step)) if (list.any { it.key == key }) return Triple(step.key, side, list)
	}
	return null
}

/** Each key's path under its function, as the Gateway spells it. */
internal fun pathsOf(steps: List<StepDraft>, base: String? = null): Map<String, String> =
	steps.withIndex().flatMap { (index, step) ->
		val path = if (base == null) "$index" else "$base.$index"
		listOf(step.key to path) + sidesOf(step).flatMap { (side, list) -> pathsOf(list, "$path.${side.number}").toList() }
	}.toMap()

/** Null when no step holds that path. */
internal fun keyAt(steps: List<StepDraft>, path: String): String? = pathsOf(steps).entries.firstOrNull { it.value == path }?.key

/** A stored body's paths, in written order. */
internal fun stepPaths(steps: List<FunctionStep>, base: String? = null): List<String> =
	steps.withIndex().flatMap { (index, step) ->
		val path = if (base == null) "$index" else "$base.$index"
		listOf(path) + sidesOf(step).flatMap { (side, list) -> stepPaths(list, "$path.${side.number}") }
	}

/** Written order: a step before what it holds. */
internal val byPath: Comparator<String> = Comparator { a, b ->
	val left = a.split(".").map { it.toInt() }
	val right = b.split(".").map { it.toInt() }
	left.zip(right).firstOrNull { (l, r) -> l != r }?.let { (l, r) -> l.compareTo(r) } ?: left.size.compareTo(right.size)
}

/** A fresh card's key. */
internal fun freshKey(): String = UUID.randomUUID().toString()

/** A stored step as cards; what a card cannot hold stays script only. */
internal fun treeOf(
	step: FunctionStep,
	offer: AutomationOffer,
	params: List<FunctionParamDraft> = emptyList(),
	key: () -> String = ::freshKey,
): StepDraft = when (step) {
	is FunctionStep.Action -> StepDraft.Action(key(), stepDraftOf(step, offer, params))
	is FunctionStep.If -> StepDraft.If(
		key(),
		step.condition,
		step.steps.orEmpty().map { treeOf(it, offer, params, key) },
		step.`else`.orEmpty().map { treeOf(it, offer, params, key) },
	)
	is FunctionStep.Try -> StepDraft.Try(
		key(),
		step.steps.map { treeOf(it, offer, params, key) },
		step.catch.map { treeOf(it, offer, params, key) },
	)
	is FunctionStep.Switch -> StepDraft.Switch(
		key(),
		step.subject,
		step.cases.map { held -> CaseDraft(key(), held.values, held.steps.map { treeOf(it, offer, params, key) }) },
		step.default.orEmpty().map { treeOf(it, offer, params, key) },
	)
	is FunctionStep.Wait -> minutesText(step.minutes)?.let { StepDraft.Wait(key(), it) } ?: StepDraft.ScriptOnly(key(), step)
	is FunctionStep.Return -> StepDraft.Return(key())
	is FunctionStep.Comment -> StepDraft.Comment(key(), step.text)
	is FunctionStep.RunFunction -> argsOf(step)?.let { StepDraft.RunFunction(key(), step.function, it) } ?: StepDraft.ScriptOnly(key(), step)
	is FunctionStep.Variable -> argText(step.value)?.let { StepDraft.Variable(key(), step.name, it, step.value) } ?: StepDraft.ScriptOnly(key(), step)
	is FunctionStep.Parallel -> StepDraft.Parallel(key(), step.steps.map { treeOf(it, offer, params, key) })
	is FunctionStep.Start -> StepDraft.Start(key(), step.`as`.orEmpty(), step.steps.map { treeOf(it, offer, params, key) })
	is FunctionStep.Await -> StepDraft.Await(key(), step.task, step.`as`.orEmpty())
	is FunctionStep.Throw -> StepDraft.Throw(key(), step.text)
	is FunctionStep.Unparsed, is FunctionStep.Unknown -> StepDraft.ScriptOnly(key(), step)
}

/** As the Value field shows it; null for what it cannot. */
internal fun argText(arg: StepArg): String? = when (arg) {
	is StepArg.Expression -> arg.text
	is StepArg.Literal -> (arg.value as? JsonPrimitive)?.let { if (it.isString) quoteConsoleString(it.content) else it.content }
}

private fun argsOf(step: FunctionStep.RunFunction): Map<String, FunctionArg>? =
	step.args.orEmpty().mapValues { (_, raw) ->
		when (val arg = runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), raw) }.getOrNull()) {
			is StepArg.Expression -> FunctionArg.Read(arg.text)
			is StepArg.Literal -> (arg.value as? JsonPrimitive)?.takeIf { it.isString || it.doubleOrNull != null }?.let { FunctionArg.Typed(it.content) }
			null -> null
		} ?: return null
	}

/** Blank defers to trigger. */
private fun runFunctionStepOf(draft: StepDraft.RunFunction, params: List<FunctionParam>?): FunctionStep? {
	val byName = params.orEmpty().associateBy { it.name }
	val args = draft.args.mapNotNull { (name, arg) ->
		val written = when (arg) {
			is FunctionArg.Read -> arg.expression.takeIf { it.isNotBlank() }?.let(StepArg::Expression)
			is FunctionArg.Typed -> {
				if (arg.text.isBlank()) null
				else {
					val param = byName[name] ?: FunctionParam(name, FunctionParamType.TEXT.wire)
					StepArg.Literal(sentArgOf(param, arg.text) ?: return null)
				}
			}
		}
		written?.let { name to wireJson.encodeToJsonElement(StepArg.serializer(), it) }
	}.toMap()
	if (draft.function.isBlank()) return null
	return FunctionStep.RunFunction(function = draft.function, args = JsonObject(args).takeIf { args.isNotEmpty() })
}

/** Number or raw text. */
private fun minutesText(arg: StepArg): String? {
	val literal = (arg as? StepArg.Literal)?.value as? JsonPrimitive ?: return null
	if (literal.isString) return literal.content.takeIf { parseDecimal(it.trim()) == null }
	return literal.content.takeIf { literal.doubleOrNull != null }
}

/** Null when unwritable. */
internal fun stepOfDraft(
	draft: StepDraft,
	offer: AutomationOffer,
	params: List<FunctionParamDraft> = emptyList(),
	calleeParams: CalleeParams,
): FunctionStep? {
	fun list(steps: List<StepDraft>): List<FunctionStep>? = steps.map { stepOfDraft(it, offer, params, calleeParams) ?: return null }
	return when (draft) {
		is StepDraft.Action -> stepOf(draft.action, offer, params)
		is StepDraft.If -> {
			val then = list(draft.then) ?: return null
			val elseSteps = list(draft.elseSteps) ?: return null
			FunctionStep.If(condition = draft.condition, steps = then.takeIf { it.isNotEmpty() }, `else` = elseSteps.takeIf { it.isNotEmpty() })
		}
		is StepDraft.Try -> FunctionStep.Try(steps = list(draft.body) ?: return null, catch = list(draft.catch) ?: return null)
		is StepDraft.Switch -> {
			val cases = draft.cases.map { held -> SwitchCase(held.values, list(held.steps) ?: return null) }
			val default = list(draft.default) ?: return null
			FunctionStep.Switch(subject = draft.subject, cases = cases, default = default.takeIf { it.isNotEmpty() })
		}
		is StepDraft.RunFunction -> runFunctionStepOf(draft, calleeParams(draft.function))
		is StepDraft.Wait -> FunctionStep.Wait(StepArg.Literal(minutesOf(draft.minutes)))
		is StepDraft.Return -> FunctionStep.Return
		is StepDraft.Comment -> FunctionStep.Comment(draft.text)
		is StepDraft.Variable -> if (!nameFits(draft.name)) null else {
			FunctionStep.Variable(draft.name, draft.read?.takeIf { argText(it) == draft.value } ?: StepArg.Expression(draft.value))
		}
		is StepDraft.Parallel -> FunctionStep.Parallel(list(draft.branches) ?: return null)
		is StepDraft.Start -> if (!optionalNameFits(draft.name)) null else {
			FunctionStep.Start(`as` = draft.name.ifBlank { null }, steps = list(draft.steps) ?: return null)
		}
		is StepDraft.Await -> if (draft.task.isBlank() || !optionalNameFits(draft.name)) null else {
			FunctionStep.Await(task = draft.task, `as` = draft.name.ifBlank { null })
		}
		is StepDraft.Throw -> FunctionStep.Throw(draft.text)
		is StepDraft.ScriptOnly -> draft.step
	}
}

/** A variable's or a task's name, as the Gateway takes one. */
internal fun nameFits(name: String): Boolean = Regex(Protocol.Wire.FUNCTION_PARAM_NAME_PATTERN).matches(name)

private fun optionalNameFits(name: String): Boolean = name.isBlank() || nameFits(name)

/** Integral numbers; invalid text stays raw. */
private fun minutesOf(text: String): JsonPrimitive {
	val trimmed = text.trim()
	val decimal = parseDecimal(trimmed) ?: return JsonPrimitive(text)
	return JsonPrimitive(trimmed.toLongOrNull() ?: decimal)
}

/** The same steps, keys aside. */
internal fun unkeyed(steps: List<StepDraft>): List<StepDraft> = steps.map { step ->
	val keyless = when (step) {
		is StepDraft.Action -> step.copy(key = "")
		is StepDraft.If -> step.copy(key = "")
		is StepDraft.Try -> step.copy(key = "")
		is StepDraft.Switch -> step.copy(key = "", cases = step.cases.map { it.copy(key = "") })
		is StepDraft.Wait -> step.copy(key = "")
		is StepDraft.Return -> step.copy(key = "")
		is StepDraft.Comment -> step.copy(key = "")
		is StepDraft.RunFunction -> step.copy(key = "")
		is StepDraft.Variable -> step.copy(key = "")
		is StepDraft.Parallel -> step.copy(key = "")
		is StepDraft.Start -> step.copy(key = "")
		is StepDraft.Await -> step.copy(key = "")
		is StepDraft.Throw -> step.copy(key = "")
		is StepDraft.ScriptOnly -> step.copy(key = "")
	}
	withSidesMapped(keyless, ::unkeyed)
}

/** Every action card, at any depth. */
internal fun actionCards(steps: List<StepDraft>): List<StepDraft.Action> = everyStep(steps).filterIsInstance<StepDraft.Action>()

/** Each card's action changed; keys unchanged. */
internal fun mapActions(steps: List<StepDraft>, change: (ActionDraft) -> ActionDraft): List<StepDraft> = steps.map { step ->
	if (step is StepDraft.Action) step.copy(action = change(step.action)) else withSidesMapped(step) { mapActions(it, change) }
}

/** A stored step's kind; an action step reads as its action. */
internal fun stepKindOf(step: FunctionStep): String = when (step) {
	is FunctionStep.Action -> step.action
	is FunctionStep.If -> "if"
	is FunctionStep.Switch -> "switch"
	is FunctionStep.Try -> "try"
	is FunctionStep.Parallel -> "parallel"
	is FunctionStep.Start -> "start"
	is FunctionStep.Await -> "await"
	is FunctionStep.Return -> "return"
	is FunctionStep.Throw -> "throw"
	is FunctionStep.Variable -> "variable"
	is FunctionStep.Wait -> "wait"
	is FunctionStep.Comment -> "comment"
	is FunctionStep.Unparsed -> "unparsed"
	is FunctionStep.RunFunction -> "run_function"
	is FunctionStep.Unknown -> step.kind
}

/** Statement kinds as their cards read. */
internal val STATEMENT_LABELS = linkedMapOf(
	"if" to "If",
	"switch" to "Switch",
	"variable" to "Variable",
	"run_function" to "Run function",
	"wait" to "Wait",
	"try" to "Try",
	"throw" to "Throw",
	"parallel" to "Parallel",
	"start" to "Start task",
	"await" to "Await task",
	"return" to "Return",
	"comment" to "Comment",
)

/** A step kind's title; an action's by its row. */
internal fun kindLabel(kind: String, offer: AutomationOffer): String =
	STATEMENT_LABELS[kind] ?: if (kind == "unparsed") "Script with errors" else offer.labelOf(kind)

/** A card's title. */
internal fun cardLabel(step: StepDraft, offer: AutomationOffer): String = when (step) {
	is StepDraft.Action -> offer.labelOf(step.action.kind)
	is StepDraft.If -> kindLabel("if", offer)
	is StepDraft.Try -> kindLabel("try", offer)
	is StepDraft.Switch -> kindLabel("switch", offer)
	is StepDraft.Wait -> kindLabel("wait", offer)
	is StepDraft.Return -> kindLabel("return", offer)
	is StepDraft.Comment -> kindLabel("comment", offer)
	is StepDraft.RunFunction -> kindLabel("run_function", offer)
	is StepDraft.Variable -> kindLabel("variable", offer)
	is StepDraft.Parallel -> kindLabel("parallel", offer)
	is StepDraft.Start -> kindLabel("start", offer)
	is StepDraft.Await -> kindLabel("await", offer)
	is StepDraft.Throw -> kindLabel("throw", offer)
	is StepDraft.ScriptOnly -> kindLabel(stepKindOf(step.step), offer)
}
