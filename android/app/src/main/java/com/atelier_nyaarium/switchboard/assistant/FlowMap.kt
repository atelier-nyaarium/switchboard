package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AssistantSource
import com.atelier_nyaarium.switchboard.proto.AutomationAction
import com.atelier_nyaarium.switchboard.proto.AutomationFunctionRow
import com.atelier_nyaarium.switchboard.proto.AutomationLastRun
import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.AutomationTrigger
import com.atelier_nyaarium.switchboard.proto.FunctionStep
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.RunOutcome
import com.atelier_nyaarium.switchboard.proto.StepArg
import com.atelier_nyaarium.switchboard.runIsolated
import com.atelier_nyaarium.switchboard.wireJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** Top-down cause order. */
internal enum class FlowRole { START, AUTOMATION, FUNCTION, ACTED }

internal sealed interface FlowKey {
	data class Source(val id: String) : FlowKey

	data class Sensor(val device: String) : FlowKey

	data class Field(val field: String) : FlowKey

	data object Clock : FlowKey

	/** Unknown trigger kind. */
	data class Trigger(val kind: String) : FlowKey

	data class Automation(val id: String) : FlowKey

	data class Function(val id: String) : FlowKey

	data class Switch(val device: String) : FlowKey

	/** Expression switch per body. */
	data class Named(val owner: FlowKey, val expression: String) : FlowKey

	data object Assistant : FlowKey

	data object Ifttt : FlowKey

	/** Unknown action kind. */
	data class Other(val kind: String) : FlowKey
}

internal fun roleOf(key: FlowKey): FlowRole = when (key) {
	is FlowKey.Source, is FlowKey.Sensor, is FlowKey.Field, FlowKey.Clock, is FlowKey.Trigger -> FlowRole.START
	is FlowKey.Automation -> FlowRole.AUTOMATION
	is FlowKey.Function -> FlowRole.FUNCTION
	is FlowKey.Switch, is FlowKey.Named, FlowKey.Assistant, FlowKey.Ifttt, is FlowKey.Other -> FlowRole.ACTED
}

/** Sheet note beside node. */
internal sealed interface FlowNote {
	data class Invalid(val reason: String) : FlowNote

	data object ScriptErrors : FlowNote

	data object Off : FlowNote

	data class Unfollowed(val function: String, val reason: com.atelier_nyaarium.switchboard.assistant.Unfollowed) : FlowNote
}

internal data class FlowNode(val key: FlowKey, val label: String, val notes: List<FlowNote> = emptyList())

internal enum class FlowAct { STARTS, POINTS, CALLS, ACTS }

internal data class FlowLine(
	val from: FlowKey,
	val to: FlowKey,
	val act: FlowAct,
	/** Failure-only edge. */
	val onFailure: Boolean,
	/** Paths by automation. */
	val steps: Map<String, Set<String>>,
)

/** Owner, guard, entered function. */
internal data class FlowStep(val owner: FlowKey, val guarded: Boolean, val enters: String? = null)

internal data class FlowGraph(
	val nodes: List<FlowNode>,
	val lines: List<FlowLine>,
	/** Automation steps by path. */
	val steps: Map<String, Map<String, FlowStep>>,
	val enabled: Map<String, Boolean>,
	/** Unrunnable automation ids. */
	val invalid: Set<String>,
	/** Last run times; lane-told runs keep no steps. */
	val ranAt: Map<String, Long>,
	val sources: Map<String, AssistantSource>,
) {
	fun node(key: FlowKey): FlowNode? = nodes.firstOrNull { it.key == key }
}

/** Gateway graph inputs. */
internal data class FlowInput(
	val rows: List<AutomationRow>,
	val functions: List<AutomationFunctionRow>,
	val sources: List<AssistantSource>,
	val switches: List<SwitchOffer>,
	val numbers: List<NumberOffer>,
)

/** Unread sources yield none. */
internal fun flowInputOf(rows: List<AutomationRow>, offer: AutomationOffer, sources: HomeSources): FlowInput = FlowInput(
	rows = rows,
	functions = offer.functions?.rows.orEmpty(),
	sources = when (sources) {
		is HomeSources.Known -> sources.sources
		HomeSources.Reading, HomeSources.Refused -> emptyList()
	},
	switches = offer.switches,
	numbers = offer.numbers,
)

private const val DEVICE = "device"
private const val ACTION_DEVICE_SET = "device_set"
private const val ACTION_IFTTT = "ifttt_trigger"
private val BARE_NAME = Regex("^[a-z][a-z0-9_]*$")

private sealed interface SiteGiven {
	data class Literal(val text: String) : SiteGiven

	data class Expression(val text: String) : SiteGiven
}

private fun givenOf(raw: JsonElement): SiteGiven? =
	when (val arg = runIsolated { wireJson.decodeFromJsonElement(StepArg.serializer(), raw) }.getOrNull()) {
		is StepArg.Literal -> (arg.value as? JsonPrimitive)?.let { SiteGiven.Literal(it.content) }
		is StepArg.Expression -> SiteGiven.Expression(arg.text)
		null -> null
	}

private fun pointerGivenOf(raw: JsonElement): SiteGiven? = (raw as? JsonPrimitive)?.let { SiteGiven.Literal(it.content) }

/** Call-site bindings and parent. */
private data class Site(val given: Map<String, SiteGiven>, val outer: String?)

private class Builder(val input: FlowInput) {
	val nodes = linkedMapOf<FlowKey, FlowNode>()
	val lines = linkedMapOf<Triple<FlowKey, FlowKey, Pair<FlowAct, Boolean>>, MutableMap<String, MutableSet<String>>>()
	val steps = linkedMapOf<String, MutableMap<String, FlowStep>>()
	private val functionRows = input.functions.associateBy { it.id }

	fun functionOf(id: String) = functionRows[id]?.function

	/** Unnamed functions stay inline. */
	fun named(id: String): Boolean = functionOf(id)?.name?.isNotEmpty() == true

	fun node(key: FlowKey, label: String) {
		if (key !in nodes) nodes[key] = FlowNode(key, label)
	}

	fun note(key: FlowKey, note: FlowNote) {
		val held = nodes[key] ?: return
		if (note !in held.notes) nodes[key] = held.copy(notes = held.notes + note)
	}

	fun line(from: FlowKey, to: FlowKey, act: FlowAct, onFailure: Boolean, automation: String, path: String?) {
		val held = lines.getOrPut(Triple(from, to, act to onFailure)) { linkedMapOf() }
		val paths = held.getOrPut(automation) { linkedSetOf() }
		if (path != null) paths += path
	}

	fun startOf(trigger: AutomationTrigger): Pair<FlowKey, String> = when (trigger) {
		is AutomationTrigger.Event ->
			FlowKey.Source(trigger.source) to (input.sources.firstOrNull { it.id == trigger.source }?.label ?: trigger.source)
		is AutomationTrigger.Crossing -> FlowKey.Sensor(trigger.device) to sensorLabel(trigger.device)
		is AutomationTrigger.Value -> FlowKey.Field(trigger.field) to trigger.field
		is AutomationTrigger.Time, is AutomationTrigger.Interval -> FlowKey.Clock to CLOCK_LABEL
		is AutomationTrigger.Unknown -> FlowKey.Trigger(trigger.kind) to trigger.kind
	}

	private fun sensorLabel(device: String): String =
		input.switches.firstOrNull { it.device == device }?.name
			?: input.numbers.firstOrNull { it.device == device }?.label
			?: device

	fun switchKey(device: String): FlowKey {
		val key = FlowKey.Switch(device)
		node(key, input.switches.firstOrNull { it.device == device }?.name ?: device)
		return key
	}

	fun actedOf(action: AutomationAction): FlowKey? = when (action) {
		is AutomationAction.TellAssistant -> FlowKey.Assistant.also { node(it, ASSISTANT_LABEL) }
		is AutomationAction.DeviceSet -> switchKey(action.device)
		is AutomationAction.IftttTrigger -> FlowKey.Ifttt.also { node(it, IFTTT_LABEL) }
		is AutomationAction.RunFunction -> null
		is AutomationAction.Unknown -> FlowKey.Other(action.kind).also { node(it, action.kind) }
	}
}

private const val CLOCK_LABEL = "Clock"
private const val ASSISTANT_LABEL = "Assistant"
private const val IFTTT_LABEL = "IFTTT"

/** Nearest ancestor call site. */
private fun siteAbove(sites: Map<String, Site>, path: String): String? {
	var at = path
	while (true) {
		val cut = at.lastIndexOf('.')
		if (cut < 0) return null
		at = at.substring(0, cut)
		if (at in sites) return at
	}
}

/** Resolve devices through bindings. */
private fun deviceOf(raw: JsonElement?, site: String?, sites: Map<String, Site>, owner: FlowKey, b: Builder): FlowKey? {
	var given = raw?.let(::givenOf) ?: return null
	var at = site
	repeat(sites.size + 1) {
		when (val held = given) {
			is SiteGiven.Literal -> return b.switchKey(held.text)
			is SiteGiven.Expression -> {
				val outer = at?.let { sites[it] }
				val next = if (BARE_NAME.matches(held.text)) outer?.given?.get(held.text) else null
				if (outer == null || next == null) {
					val key = FlowKey.Named(owner, held.text)
					b.node(key, held.text)
					return key
				}
				given = next
				at = outer.outer
			}
		}
	}
	return null
}

/** Lines from the walk alone. */
internal fun flowGraph(input: FlowInput): FlowGraph {
	val b = Builder(input)
	for (row in input.rows) {
		val (start, label) = b.startOf(row.automation.trigger)
		b.node(start, label)
		val self = FlowKey.Automation(row.id)
		b.node(self, row.sentence)
		row.invalid?.let { b.note(self, FlowNote.Invalid(it)) }
		if (!row.automation.enabled) b.note(self, FlowNote.Off)
		b.line(start, self, FlowAct.STARTS, false, row.id, null)
		val reached = b.steps.getOrPut(row.id) { linkedMapOf() }
		val sites = linkedMapOf<String, Site>()
		val entries = reached(row.automation) { b.functionOf(it) }
		val unfollowed = mutableSetOf<String>()
		for (entry in entries) {
			when (entry) {
				is UnfollowedCall -> unfollowed += entry.path
				is WalkAction, is WalkStep -> Unit
			}
		}
		written(row.automation).forEachIndexed { index, action ->
			if (action !is AutomationAction.RunFunction) return@forEachIndexed
			val path = index.toString()
			sites[path] = Site(action.values.orEmpty().mapNotNull { (k, v) -> pointerGivenOf(v)?.let { k to it } }.toMap(), null)
			reached[path] = FlowStep(self, guarded = false, enters = action.function)
			if (path !in unfollowed && b.named(action.function)) {
				b.node(FlowKey.Function(action.function), b.functionOf(action.function)!!.name)
				b.line(self, FlowKey.Function(action.function), FlowAct.POINTS, false, row.id, path)
			}
		}
		val held = mutableMapOf<String, WalkStep>()
		for (entry in entries) {
			when (entry) {
				is WalkAction -> {
					reached[entry.path] = FlowStep(self, guarded = false)
					b.actedOf(entry.action)?.let { b.line(self, it, FlowAct.ACTS, false, row.id, entry.path) }
				}
				is UnfollowedCall -> {
					val owner = reached[entry.path]?.owner ?: self
					b.note(owner, FlowNote.Unfollowed(entry.call.function, entry.reason))
				}
				is WalkStep -> {
					held[entry.path] = entry
					val owner = if (b.named(entry.via)) FlowKey.Function(entry.via) else self
					val (guarded, caught) = guardOf(entry, held)
					val site = siteAbove(sites, entry.path)
					when (val step = entry.step) {
						is FunctionStep.Do -> {
							reached[entry.path] = FlowStep(owner, guarded)
							val target = when (step.action) {
								ACTION_DEVICE_SET -> deviceOf(step.args[DEVICE], site, sites, owner, b)
								ACTION_TELL -> FlowKey.Assistant.also { b.node(it, ASSISTANT_LABEL) }
								ACTION_IFTTT -> FlowKey.Ifttt.also { b.node(it, IFTTT_LABEL) }
								else -> FlowKey.Other(step.action).also { b.node(it, step.action) }
							}
							target?.let { b.line(owner, it, FlowAct.ACTS, caught, row.id, entry.path) }
						}
						is FunctionStep.Call -> {
							reached[entry.path] = FlowStep(owner, guarded, enters = step.function)
							sites[entry.path] = Site(step.values.orEmpty().mapNotNull { (k, v) -> givenOf(v)?.let { k to it } }.toMap(), site)
							if (entry.path !in unfollowed && b.named(step.function)) {
								b.node(FlowKey.Function(step.function), b.functionOf(step.function)!!.name)
								b.line(owner, FlowKey.Function(step.function), FlowAct.CALLS, caught, row.id, entry.path)
							}
						}
						is FunctionStep.Unparsed -> {
							reached[entry.path] = FlowStep(owner, guarded)
							b.note(owner, FlowNote.ScriptErrors)
						}
						is FunctionStep.If, is FunctionStep.Switch, is FunctionStep.Try, is FunctionStep.Parallel,
						is FunctionStep.Start, is FunctionStep.Await, is FunctionStep.Exit, is FunctionStep.Throw,
						is FunctionStep.Let, is FunctionStep.Wait, is FunctionStep.Note,
						is FunctionStep.Unknown -> reached[entry.path] = FlowStep(owner, guarded)
					}
				}
			}
		}
	}
	return FlowGraph(
		nodes = b.nodes.values.toList(),
		lines = b.lines.map { (key, steps) ->
			FlowLine(key.first, key.second, key.third.first, key.third.second, steps.mapValues { it.value.toSet() })
		},
		steps = b.steps,
		enabled = input.rows.associate { it.id to it.automation.enabled },
		invalid = input.rows.filter { it.invalid != null }.map { it.id }.toSet(),
		ranAt = input.rows.mapNotNull { row -> row.lastRanAt?.let { row.id to it } }.toMap(),
		sources = input.sources.associateBy { it.id },
	)
}

/** Held by any try above it, a caller's too; in a catch of its own body. */
private fun guardOf(entry: WalkStep, held: Map<String, WalkStep>): Pair<Boolean, Boolean> {
	val parts = entry.path.split('.')
	var guarded = false
	var caught = false
	for (cut in parts.size - 1 downTo 1) {
		val above = held[parts.subList(0, cut).joinToString(".")] ?: continue
		if (above.step !is FunctionStep.Try) continue
		when (sidesOf(above.step).firstOrNull { (side, _) -> "${side.number}" == parts[cut] }?.first) {
			Side.Body -> guarded = true
			Side.Catch -> if (above.via == entry.via) caught = true
			Side.Then, Side.Else, is Side.Case, is Side.Default, null -> Unit
		}
	}
	return guarded to caught
}

/** How its newest part ended. */
internal enum class FlowEnded { DONE, NOT_CLEAN, NOT_DONE, NOTHING }

internal enum class FlowHappened { RAN, NOW, NOT }

internal data class FlowFacts(
	val ended: FlowEnded,
	val happened: FlowHappened,
	/** Uncaught failure starts here. */
	val failureStart: Boolean = false,
	val onFailure: Boolean = false,
	/** Failure reason and time. */
	val said: FlowSaid? = null,
)

internal data class FlowSaid(val reason: String, val at: Long)

/** When its newest act was: run time plus step time, then written order. */
internal data class ActAt(val at: Long, val order: Int) : Comparable<ActAt> {
	override fun compareTo(other: ActAt): Int = compareValuesBy(this, other, { it.at }, { it.order })
}

internal data class FlowFactsMap(
	val nodes: Map<FlowKey, FlowFacts>,
	val lines: List<FlowFacts>,
	/** Each line's newest act; null when none ran. */
	val lineAt: List<ActAt?>,
)

private fun actAt(run: AutomationLastRun, held: List<AutomationLastStep>): ActAt =
	held.maxOf { step -> ActAt(run.at + (step.endMs ?: step.startMs ?: 0), run.steps.indexOf(step)) }

private val NOTHING = FlowFacts(FlowEnded.NOTHING, FlowHappened.NOT)

private fun FlowEnded.rank(): Int = when (this) {
	FlowEnded.NOTHING -> 0
	FlowEnded.DONE -> 1
	FlowEnded.NOT_CLEAN -> 2
	FlowEnded.NOT_DONE -> 3
}

private fun worst(states: List<FlowEnded>): FlowEnded = states.maxByOrNull { it.rank() } ?: FlowEnded.NOTHING

/** Null while open; a word this build lacks reads unclean. */
internal fun outcomeOf(step: AutomationLastStep): RunOutcome? =
	step.outcome?.let { said -> RunOutcome.entries.find { it.wire == said } ?: RunOutcome.UNCERTAIN }

/** An open step of an ended run never said how. */
internal fun stateOf(step: AutomationLastStep, running: Boolean): FlowEnded = when (outcomeOf(step)) {
	null -> if (step.retrying == true || !running) FlowEnded.NOT_CLEAN else FlowEnded.DONE
	RunOutcome.RAN -> FlowEnded.DONE
	RunOutcome.REFUSED -> FlowEnded.NOT_DONE
	RunOutcome.UNCERTAIN, RunOutcome.SUPPRESSED -> FlowEnded.NOT_CLEAN
}

private fun AutomationLastStep.open(): Boolean = outcome == null

/** Deepest unguarded failures. */
internal fun failureStarts(run: AutomationLastRun, steps: Map<String, FlowStep>?): Set<String> {
	val loose = run.steps.filter { outcomeOf(it) == RunOutcome.REFUSED && steps?.get(it.path)?.guarded != true }.map { it.path }
	return loose.filter { path -> loose.none { it.startsWith("$path.") } }.toSet()
}

/** Facts across selected steps. */
private fun factsOver(run: AutomationLastRun, held: List<AutomationLastStep>, starts: Set<String>, onFailure: Boolean): FlowFacts {
	val said = held.filter { outcomeOf(it) == RunOutcome.REFUSED && it.reason != null }
		.maxByOrNull { it.startMs ?: 0 }
		?.let { FlowSaid(it.reason!!, run.at + (it.endMs ?: it.startMs ?: 0)) }
	return FlowFacts(
		ended = worst(held.map { stateOf(it, run.running) }),
		happened = if (run.running && held.any { it.open() }) FlowHappened.NOW else FlowHappened.RAN,
		failureStart = held.any { it.path in starts },
		onFailure = onFailure,
		said = said,
	)
}

/** `prefer` reads one automation's run where it reaches. */
internal fun flowFacts(graph: FlowGraph, runs: Map<String, AutomationLastRun>, prefer: String? = null): FlowFactsMap {
	val starts = runs.mapValues { (id, run) -> failureStarts(run, graph.steps[id]) }
	val onLines = graph.lines.flatMap { line -> line.steps.flatMap { (id, paths) -> paths.map { id to it } } }.toSet()
	val stopped = { id: String -> graph.enabled[id] == false || id in graph.invalid }
	val off = { ids: Collection<String> -> ids.isNotEmpty() && ids.all(stopped) }

	/** Newest act on these paths, with its run. */
	fun newest(byAutomation: Map<String, Set<String>>): Newest? {
		val pick = if (prefer != null && prefer in byAutomation) mapOf(prefer to byAutomation.getValue(prefer)) else byAutomation
		return pick.mapNotNull { (id, paths) ->
			val run = runs[id] ?: return@mapNotNull null
			val held = run.steps.filter { it.path in paths }
			if (held.isEmpty()) null else Newest(id, run, held, actAt(run, held))
		}.maxByOrNull { it.at }
	}

	fun toldAt(ids: Collection<String>): Long? = ids.filter { runs[it] == null }.mapNotNull { graph.ranAt[it] }.maxOrNull()
	val told = FlowFacts(FlowEnded.DONE, FlowHappened.RAN)

	val lineAt = graph.lines.map { line ->
		when (line.act) {
			FlowAct.STARTS -> (line.to as FlowKey.Automation).id.let { id ->
				runs[id]?.let { ActAt(it.at, -1) } ?: toldAt(listOf(id))?.let { ActAt(it, -1) }
			}
			FlowAct.POINTS, FlowAct.CALLS, FlowAct.ACTS ->
				newest(line.steps)?.at ?: toldAt(line.steps.keys)?.let { ActAt(it, -1) }
		}
	}
	val lineFacts = graph.lines.map { line ->
		val facts = when (line.act) {
			FlowAct.STARTS -> {
				val id = (line.to as FlowKey.Automation).id
				if (runs[id] == null && toldAt(listOf(id)) == null) NOTHING else told
			}
			FlowAct.POINTS, FlowAct.CALLS, FlowAct.ACTS ->
				newest(line.steps)?.let { (id, run, held) -> factsOver(run, held, starts.getValue(id), line.onFailure) }
					?: (if (toldAt(line.steps.keys) != null) told else NOTHING).copy(onFailure = line.onFailure)
		}
		if (off(line.steps.keys)) facts.copy(happened = FlowHappened.NOT) else facts
	}

	/** `entry` ran this body; `whole` reads every step. */
	fun bodyFacts(owner: FlowKey, id: String, run: AutomationLastRun, entry: List<AutomationLastStep>, whole: Boolean): FlowFacts {
		val ownStarts = starts.getValue(id).filter { graph.steps[id]?.get(it)?.owner == owner && (id to it) !in onLines }
		val inside = if (whole) run.steps else run.steps.filter { step -> entry.any { step.path == it.path || step.path.startsWith("${it.path}.") } }
		val retrying = inside.any { it.open() && it.retrying == true }
		val ended = worst(entry.map { stateOf(it, run.running) } + listOfNotNull(FlowEnded.NOT_CLEAN.takeIf { retrying }))
		return FlowFacts(
			ended = if (ended == FlowEnded.NOTHING) FlowEnded.DONE else ended,
			happened = if (run.running && (entry.isEmpty() || entry.any { it.open() })) FlowHappened.NOW else FlowHappened.RAN,
			failureStart = ownStarts.isNotEmpty(),
		)
	}

	val nodeFacts = mutableMapOf<FlowKey, FlowFacts>()
	for (node in graph.nodes) {
		val key = node.key
		val facts = when (key) {
			is FlowKey.Automation -> if (key.id in graph.invalid) NOTHING else (
				runs[key.id]?.let { run -> bodyFacts(key, key.id, run, run.steps.filter { '.' !in it.path }, whole = true) }
					?: told.takeIf { toldAt(listOf(key.id)) != null }
			)?.let { if (stopped(key.id)) it.copy(happened = FlowHappened.NOT) else it } ?: NOTHING
			is FlowKey.Function -> {
				val entries = graph.steps.mapValues { (_, steps) -> steps.filterValues { it.enters == key.id }.keys }.filterValues { it.isNotEmpty() }
				newest(entries)?.let { (id, run, held) -> bodyFacts(key, id, run, held, whole = false) }
					?.let { if (off(entries.keys)) it.copy(happened = FlowHappened.NOT) else it } ?: NOTHING
			}
			is FlowKey.Source -> sourceFacts(graph.sources[key.id])
			is FlowKey.Sensor, is FlowKey.Field, FlowKey.Clock, is FlowKey.Trigger -> {
				val started = graph.lines.filter { it.from == key }.map { (it.to as FlowKey.Automation).id }
				if (started.any { runs[it] != null || graph.ranAt[it] != null }) told else NOTHING
			}
			is FlowKey.Switch, is FlowKey.Named, FlowKey.Assistant, FlowKey.Ifttt, is FlowKey.Other -> {
				val into = graph.lines.withIndex().filter { it.value.to == key }
					.let { all -> all.filter { prefer != null && prefer in it.value.steps }.ifEmpty { all } }
				into.mapNotNull { (index, _) -> lineAt[index]?.let { it to lineFacts[index] } }
					.maxByOrNull { it.first }?.second?.copy(failureStart = false, onFailure = false, said = null) ?: NOTHING
			}
		}
		nodeFacts[key] = facts
	}
	return FlowFactsMap(nodeFacts, lineFacts, lineAt)
}

/** A newest act and the run holding it. */
private data class Newest(val id: String, val run: AutomationLastRun, val held: List<AutomationLastStep>, val at: ActAt)

internal fun flowRuns(rows: List<AutomationRow>): Map<String, AutomationLastRun> =
	rows.mapNotNull { row -> row.lastRun?.let { row.id to it } }.toMap()

/** Latest source poll state. */
private fun sourceFacts(source: AssistantSource?): FlowFacts = when {
	source == null -> NOTHING
	source.stopped != null -> FlowFacts(FlowEnded.NOT_DONE, FlowHappened.RAN)
	source.backoff != null -> FlowFacts(FlowEnded.NOT_CLEAN, FlowHappened.RAN)
	source.lastSuccessAt != null -> FlowFacts(FlowEnded.DONE, FlowHappened.RAN)
	else -> NOTHING
}

/** Reach around tapped node. */
internal fun flowReach(graph: FlowGraph, key: FlowKey): Set<FlowLine> {
	// Lines carry automation ids.
	if (key is FlowKey.Automation) return graph.lines.filter { key.id in it.steps }.toSet()
	val up = mutableSetOf(key)
	val down = mutableSetOf(key)
	val lines = mutableSetOf<FlowLine>()
	var grew = true
	while (grew) {
		grew = false
		for (line in graph.lines) {
			if (line.to in up) {
				lines += line
				if (up.add(line.from)) grew = true
			}
			if (line.from in down) {
				lines += line
				if (down.add(line.to)) grew = true
			}
		}
	}
	return lines
}

/** Reach nodes and target. */
internal fun reachedNodes(key: FlowKey, lines: Set<FlowLine>): Set<FlowKey> = lines.flatMap { listOf(it.from, it.to) }.toSet() + key

/** Colour shows outcome. */
internal enum class FlowColour { OK, AMBER, RED, FAINT }

/** Pattern shows occurrence. */
internal enum class FlowPattern { SOLID, MOVING_DASH, DOTS }

/** Weight controls emphasis. */
internal enum class FlowWeight { THIN, THICK }

internal fun colourOf(facts: FlowFacts): FlowColour = when (facts.ended) {
	FlowEnded.DONE -> FlowColour.OK
	FlowEnded.NOT_CLEAN -> FlowColour.AMBER
	FlowEnded.NOT_DONE -> FlowColour.RED
	FlowEnded.NOTHING -> FlowColour.FAINT
}

internal fun patternOf(facts: FlowFacts): FlowPattern = when (facts.happened) {
	FlowHappened.RAN -> FlowPattern.SOLID
	FlowHappened.NOW -> FlowPattern.MOVING_DASH
	FlowHappened.NOT -> FlowPattern.DOTS
}

internal fun weightOf(facts: FlowFacts): FlowWeight = when (facts.failureStart) {
	true -> FlowWeight.THICK
	false -> FlowWeight.THIN
}
