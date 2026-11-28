package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AutomationLastStep
import com.atelier_nyaarium.switchboard.proto.AutomationRow
import com.atelier_nyaarium.switchboard.proto.Protocol.Wire.RunOutcome

/** Tapped node details. */
internal sealed interface FlowSheet {
	data class OfAutomation(
		val id: String,
		val sentence: String,
		val notes: List<FlowNote>,
		val steps: List<SheetStep>,
		val replays: Boolean,
		/** Ran with no steps recorded. */
		val ranAt: Long?,
	) : FlowSheet

	data class OfFunction(val id: String, val name: String, val notes: List<FlowNote>, val runBy: List<SheetUser>) : FlowSheet

	data class OfThing(val label: String, val touches: List<SheetTouch>) : FlowSheet
}

internal data class SheetStep(
	val path: String,
	val kind: String,
	val ended: FlowEnded,
	val reason: String?,
	val function: String?,
	val tookMs: Long?,
	val open: Boolean,
	/** Its own outcome, as a word. */
	val word: String,
)

internal data class SheetUser(val id: String, val sentence: String)

/** Thing touch outcome. */
internal data class SheetTouch(val label: String, val ended: FlowEnded)

/** A step's outcome word; an open step of a running run is running. */
internal fun stepWord(step: AutomationLastStep, running: Boolean): String = when (outcomeOf(step)) {
	null -> if (running) "Running" else "Unsure"
	RunOutcome.DONE -> "Done"
	RunOutcome.FAILED -> "Failed"
	RunOutcome.UNSURE -> "Unsure"
	RunOutcome.SKIPPED -> "Skipped"
}

internal fun flowSheet(graph: FlowGraph, facts: FlowFactsMap, rows: List<AutomationRow>, key: FlowKey): FlowSheet? {
	val node = graph.node(key) ?: return null
	val label = { at: FlowKey -> graph.node(at)?.label ?: "" }
	return when (key) {
		is FlowKey.Automation -> {
			val row = rows.firstOrNull { it.id == key.id } ?: return null
			val running = row.lastRun?.running == true
			FlowSheet.OfAutomation(
				id = key.id,
				sentence = row.sentence,
				notes = node.notes,
				steps = row.lastRun?.steps.orEmpty().map { step ->
					val took = step.startMs?.let { start -> step.endMs?.let { it - start } }
					SheetStep(step.path, step.kind, stateOf(step, running), step.reason, step.function, took, running && step.outcome == null, stepWord(step, running))
				},
				replays = row.lastRun != null,
				ranAt = row.lastRanAt.takeIf { row.lastRun == null },
			)
		}
		is FlowKey.Function -> FlowSheet.OfFunction(
			id = key.id,
			name = node.label,
			notes = node.notes,
			runBy = graph.lines.filter { it.to == key }.flatMap { it.steps.keys }.distinct().mapNotNull { id ->
				rows.firstOrNull { it.id == id }?.let { SheetUser(id, it.sentence) }
			},
		)
		is FlowKey.Source, is FlowKey.Sensor, is FlowKey.Field, FlowKey.Schedule, is FlowKey.Trigger,
		is FlowKey.Plug, is FlowKey.Named, FlowKey.Assistant, FlowKey.Ifttt, is FlowKey.Other -> FlowSheet.OfThing(
			label = node.label,
			touches = graph.lines.indices
				.filter { graph.lines[it].from == key || graph.lines[it].to == key }
				.groupBy { graph.lines[it].let { line -> if (line.from == key) line.to else line.from } }
				.map { (other, lines) ->
					val newest = lines.maxWithOrNull(compareBy(nullsFirst()) { facts.lineAt[it] })!!
					SheetTouch(label(other), facts.lines[newest].ended)
				},
		)
	}
}

/** A selection outlives a refresh only while its node is drawn. */
internal fun selectionAfter(graph: FlowGraph, picked: FlowKey?): FlowKey? = picked?.takeIf { graph.node(it) != null }

/** A replay stands while its run is still the row's last run. */
internal fun replayStands(rows: List<AutomationRow>, id: String, run: com.atelier_nyaarium.switchboard.proto.AutomationLastRun): Boolean =
	rows.firstOrNull { it.id == id }?.lastRun == run

internal data class FlowSummary(val total: Int, val failed: Int, val running: Int)

internal fun flowSummary(rows: List<AutomationRow>, facts: FlowFactsMap): FlowSummary = FlowSummary(
	total = rows.size,
	failed = rows.count { row ->
		row.lastRun?.running == false && facts.nodes[FlowKey.Automation(row.id)]?.ended == FlowEnded.FAILED
	},
	running = rows.count { it.lastRun?.running == true },
)

internal fun summaryLine(summary: FlowSummary): String = listOfNotNull(
	"${summary.total} automation${if (summary.total == 1) "" else "s"}",
	summary.failed.takeIf { it > 0 }?.let { "$it failed" },
	summary.running.takeIf { it > 0 }?.let { "$it running" },
).joinToString(" · ")

internal fun tookText(ms: Long): String = when {
	ms < 10_000 -> String.format(java.util.Locale.ROOT, "%.1f s", ms / 1000.0)
	ms < 120_000 -> "${ms / 1000} s"
	else -> "${(ms + 30_000) / 60_000} min"
}

internal fun noteText(note: FlowNote): String = when (note) {
	is FlowNote.Invalid -> note.reason
	FlowNote.ScriptErrors -> SCRIPT_ERRORS_LINE
	FlowNote.Off -> "Switched off"
	is FlowNote.Unfollowed -> when (note.reason) {
		Unfollowed.MISSING -> "Runs a function this Gateway does not list"
		Unfollowed.LOOP -> "A function that leads back to itself is not followed"
		Unfollowed.BUDGET -> "Reaches more steps than can be followed"
		Unfollowed.NOT_EXPANDED -> "A function not followed"
	}
}

internal fun endedWord(ended: FlowEnded): String = when (ended) {
	FlowEnded.DONE -> "Done"
	FlowEnded.WITH_FAILURES -> "Done with failures"
	FlowEnded.FAILED -> "Failed"
	FlowEnded.NOT_RUN -> "Not run"
}

/** What a legend row draws. */
internal enum class LegendSample { RING, AUTOMATION, FUNCTION, LINE, PICKED, MOMENT }

internal data class LegendRow(val sample: LegendSample, val facts: FlowFacts, val title: String)

internal data class LegendGroup(val heading: String, val rows: List<LegendRow>)

private val RAN = FlowFacts(FlowEnded.DONE, FlowHappened.RAN)

/** Drawn through the map's own styles. */
internal val FLOW_LEGEND = listOf(
	LegendGroup(
		"Shape",
		listOf(
			LegendRow(LegendSample.RING, RAN, "Trigger or target"),
			LegendRow(LegendSample.AUTOMATION, RAN, "Automation"),
			LegendRow(LegendSample.FUNCTION, RAN, "Function"),
			LegendRow(LegendSample.LINE, RAN, "Leads to"),
			LegendRow(LegendSample.LINE, RAN.copy(onFailure = true), "On error"),
		),
	),
	LegendGroup(
		"Colour",
		listOf(
			LegendRow(LegendSample.LINE, RAN, endedWord(FlowEnded.DONE)),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.WITH_FAILURES, FlowHappened.RAN), endedWord(FlowEnded.WITH_FAILURES)),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.FAILED, FlowHappened.RAN), endedWord(FlowEnded.FAILED)),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.NOT_RUN, FlowHappened.RAN), "Never ran"),
		),
	),
	LegendGroup(
		"Pattern",
		listOf(
			LegendRow(LegendSample.LINE, RAN, "Ran"),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.DONE, FlowHappened.NOW), "Running"),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.NOT_RUN, FlowHappened.NOT), endedWord(FlowEnded.NOT_RUN)),
		),
	),
	LegendGroup(
		"Emphasis",
		listOf(
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.FAILED, FlowHappened.RAN, failureStart = true), "Error began here"),
			LegendRow(LegendSample.PICKED, RAN, "Selected"),
			LegendRow(LegendSample.MOMENT, FlowFacts(FlowEnded.DONE, FlowHappened.NOW), "Replay position"),
		),
	),
)
