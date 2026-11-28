package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.Automation
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunction
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.OpensWalk
import com.atelier_nyaarium.switchboard.proto.Protocol

/** Exhaustive walk entry. */
internal sealed interface WalkEntry {
	val path: String
}

/** Automation action, not a function run. */
internal data class WalkAction(override val path: String, val index: Int, val action: AutomationAction) : WalkEntry

/** A run function's step, any depth. */
internal data class WalkStep(override val path: String, val index: Int, val step: FunctionStep, val via: String) : WalkEntry

internal enum class Unfollowed(val wire: String) {
	/** Walked without functions. */
	NOT_EXPANDED("not-expanded"),

	/** Function not held. */
	MISSING("missing"),

	/** Already above it. */
	LOOP("loop"),

	/** Past the walk's bound. */
	BUDGET("budget"),
}

internal data class UnfollowedFunction(
	override val path: String,
	val runFunction: AutomationAction.RunFunction,
	val reason: Unfollowed,
) : WalkEntry

private class Budget(var left: Int, var frames: Int)

@OptIn(OpensWalk::class)
private fun walk(automation: Automation, functionOf: ((String) -> AutomationFunction?)?): List<WalkEntry> {
	val budget = Budget(Protocol.Wire.WALK_ENTRIES_MAX, Protocol.Wire.RUN_FRAMES_MAX)
	return automation.actions.flatMapIndexed { at, action ->
		val path = at.toString()
		when {
			action !is AutomationAction.RunFunction -> listOf(WalkAction(path, at, action))
			functionOf == null -> listOf(UnfollowedFunction(path, action, Unfollowed.NOT_EXPANDED))
			else -> followed(action, path, emptyList(), functionOf, budget)
		}
	}
}

/** Steps under the run's path. */
private fun followed(
	run: AutomationAction.RunFunction,
	site: String,
	chain: List<String>,
	functionOf: (String) -> AutomationFunction?,
	budget: Budget,
): List<WalkEntry> {
	if (run.function in chain) return listOf(UnfollowedFunction(site, run, Unfollowed.LOOP))
	val function = functionOf(run.function) ?: return listOf(UnfollowedFunction(site, run, Unfollowed.MISSING))
	val steps = stepsIn(written(function), emptyList())
	if (steps.size > budget.left || budget.frames == 0) return listOf(UnfollowedFunction(site, run, Unfollowed.BUDGET))
	budget.left -= steps.size
	budget.frames -= 1
	val above = chain + run.function
	return steps.flatMap { (numbers, step) ->
		val path = (listOf(site) + numbers.map { it.toString() }).joinToString(".")
		val here = WalkStep(path, numbers.last(), step, run.function)
		if (step !is FunctionStep.RunFunction) listOf(here)
		else listOf(here) + followed(AutomationAction.RunFunction(function = step.function), path, above, functionOf, budget)
	}
}

/** Side index in path. */
internal sealed class Side(val number: Int) {
	data object Then : Side(0)

	data object Else : Side(1)

	data object Body : Side(0)

	data object Catch : Side(1)

	data class Case(val index: Int) : Side(index)

	data class Default(val at: Int) : Side(at)
}

/** Stored-side order is canonical. */
internal fun sidesOf(step: FunctionStep): List<Pair<Side, List<FunctionStep>>> = when (step) {
	is FunctionStep.If -> listOf(Side.Then to step.steps.orEmpty(), Side.Else to step.`else`.orEmpty())
	is FunctionStep.Switch ->
		step.cases.mapIndexed { at, held -> Side.Case(at) to held.steps } +
			(Side.Default(step.cases.size) to step.default.orEmpty())
	is FunctionStep.Try -> listOf(Side.Body to step.steps, Side.Catch to step.catch)
	is FunctionStep.Parallel -> listOf(Side.Body to step.steps)
	is FunctionStep.Start -> listOf(Side.Body to step.steps)
	is FunctionStep.Action, is FunctionStep.Return, is FunctionStep.Throw, is FunctionStep.Variable, is FunctionStep.Await,
	is FunctionStep.Wait, is FunctionStep.Comment, is FunctionStep.Unparsed, is FunctionStep.RunFunction, is FunctionStep.Unknown -> emptyList()
}

/** Parents precede children. */
private fun stepsIn(steps: List<FunctionStep>, base: List<Int>): List<Pair<List<Int>, FunctionStep>> =
	steps.withIndex().flatMap { (index, step) ->
		val at = base + index
		listOf(at to step) + sidesOf(step).flatMap { (side, list) -> stepsIn(list, at + side.number) }
	}

/** Unexpanded runs, written order. */
internal fun reached(automation: Automation): List<WalkEntry> = walk(automation, null)

/** Follow available functions. */
internal fun reached(automation: Automation, functionOf: (String) -> AutomationFunction?): List<WalkEntry> =
	walk(automation, functionOf)

internal fun stepsOf(function: AutomationFunction): List<FunctionStep> = stepsIn(written(function), emptyList()).map { it.second }

/** Every depth, step excluded. */
internal fun stepsUnder(step: FunctionStep): List<FunctionStep> = stepsIn(listOf(step), emptyList()).drop(1).map { it.second }

/** A function's steps as written. */
@OptIn(OpensWalk::class)
internal fun written(function: AutomationFunction): List<FunctionStep> = function.steps

/** The functions a function's steps run, at any depth. */
internal fun functionsRunBy(function: AutomationFunction): List<String> = runIn(written(function))

/** Includes `starts`. */
internal fun reachOver(starts: Collection<String>, functionsRunBy: (String) -> List<String>): Set<String> {
	val seen = mutableSetOf<String>()
	val queue = ArrayDeque(starts.filter { it.isNotBlank() })
	while (queue.isNotEmpty()) {
		val id = queue.removeFirst()
		if (seen.add(id)) queue += functionsRunBy(id)
	}
	return seen
}

/** Stored steps' runs. */
internal fun functionsRunIn(steps: List<FunctionStep>): List<String> = runIn(steps)

private fun runIn(steps: List<FunctionStep>): List<String> = steps.flatMap { step ->
	listOfNotNull((step as? FunctionStep.RunFunction)?.function) + sidesOf(step).flatMap { (_, list) -> runIn(list) }
}

/** The list as written, one level; a function run is never followed. */
@OptIn(OpensWalk::class)
internal fun written(automation: Automation): List<AutomationAction> = automation.actions
