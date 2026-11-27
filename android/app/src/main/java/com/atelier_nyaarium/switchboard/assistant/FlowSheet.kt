package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AutomationRow

/** Tapped node details. */
internal sealed interface FlowSheet {
	data class OfAutomation(
		val id: String,
		val sentence: String,
		val notes: List<FlowNote>,
		val steps: List<SheetStep>,
		val replays: Boolean,
		/** Ran with no steps kept. */
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
)

internal data class SheetUser(val id: String, val sentence: String)

/** Thing touch outcome. */
internal data class SheetTouch(val label: String, val ended: FlowEnded)

internal fun flowSheet(graph: FlowGraph, facts: FlowFactsMap, rows: List<AutomationRow>, key: FlowKey): FlowSheet? {
	val node = graph.node(key) ?: return null
	val label = { at: FlowKey -> graph.node(at)?.label ?: "" }
	return when (key) {
		is FlowKey.Automation -> {
			val row = rows.firstOrNull { it.id == key.id } ?: return null
			FlowSheet.OfAutomation(
				id = key.id,
				sentence = row.sentence,
				notes = node.notes,
				steps = row.lastRun?.steps.orEmpty().map { step ->
					val took = step.startMs?.let { start -> step.endMs?.let { it - start } }
					SheetStep(step.path, step.kind, stateOf(step, row.lastRun?.running == true), step.reason, step.function, took, row.lastRun?.running == true && step.outcome == null)
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
		is FlowKey.Source, is FlowKey.Sensor, is FlowKey.Field, FlowKey.Clock, is FlowKey.Trigger,
		is FlowKey.Switch, is FlowKey.Named, FlowKey.Assistant, FlowKey.Ifttt, is FlowKey.Other -> FlowSheet.OfThing(
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

internal data class FlowSummary(val total: Int, val unfinished: Int, val running: Int)

internal fun flowSummary(rows: List<AutomationRow>, facts: FlowFactsMap): FlowSummary = FlowSummary(
	total = rows.size,
	unfinished = rows.count { row ->
		row.lastRun?.running == false && facts.nodes[FlowKey.Automation(row.id)]?.ended == FlowEnded.NOT_DONE
	},
	running = rows.count { it.lastRun?.running == true },
)

internal fun summaryLine(summary: FlowSummary): String = listOfNotNull(
	"${summary.total} automation${if (summary.total == 1) "" else "s"}",
	summary.unfinished.takeIf { it > 0 }?.let { "$it did not finish" },
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
		Unfollowed.LOOP -> "A call that loops back is not followed"
		Unfollowed.BUDGET -> "Reaches more steps than can be followed"
		Unfollowed.NOT_EXPANDED -> "A call not followed"
	}
}

internal fun endedWord(ended: FlowEnded): String = when (ended) {
	FlowEnded.DONE -> "ran"
	FlowEnded.NOT_CLEAN -> "not clean"
	FlowEnded.NOT_DONE -> "failed"
	FlowEnded.NOTHING -> "not run"
}

/** What a legend row draws. */
internal enum class LegendSample { RING, AUTOMATION, FUNCTION, LINE, PICKED, MOMENT }

internal data class LegendRow(val sample: LegendSample, val facts: FlowFacts, val title: String, val note: String? = null)

internal data class LegendGroup(val heading: String, val rows: List<LegendRow>)

private val RAN = FlowFacts(FlowEnded.DONE, FlowHappened.RAN)

/** Drawn through the map's own styles. */
internal val FLOW_LEGEND = listOf(
	LegendGroup(
		"Shape is what it is",
		listOf(
			LegendRow(LegendSample.RING, RAN, "Something outside", "Above: what starts a run. Below: what a run acts on."),
			LegendRow(LegendSample.AUTOMATION, RAN, "An automation"),
			LegendRow(LegendSample.FUNCTION, RAN, "A named function"),
			LegendRow(LegendSample.LINE, RAN, "One act, pointing down at what it causes", "Start a run, run a function, call one, act on a thing."),
			LegendRow(LegendSample.LINE, RAN.copy(onFailure = true), "An act that runs only when something failed"),
		),
	),
	LegendGroup(
		"Colour is how it ended",
		listOf(
			LegendRow(LegendSample.LINE, RAN, "Done as written"),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.NOT_CLEAN, FlowHappened.RAN), "Not clean", "Held up, retried, or no answer came back."),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.NOT_DONE, FlowHappened.RAN), "Not done"),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.NOTHING, FlowHappened.RAN), "Nothing to show"),
		),
	),
	LegendGroup(
		"Pattern is whether it happened",
		listOf(
			LegendRow(LegendSample.LINE, RAN, "Happened, in its last run"),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.DONE, FlowHappened.NOW), "Happening now", "The dashes move."),
			LegendRow(LegendSample.LINE, FlowFacts(FlowEnded.NOTHING, FlowHappened.NOT), "Did not happen", "Switched off, or its last run never got there."),
		),
	),
	LegendGroup(
		"Weight, fill and motion",
		listOf(
			LegendRow(
				LegendSample.LINE,
				FlowFacts(FlowEnded.NOT_DONE, FlowHappened.RAN, failureStart = true),
				"Look here first",
				"Where a failure nothing caught began. Red that only follows from it stays thin.",
			),
			LegendRow(LegendSample.PICKED, RAN, "What you tapped", "Everything outside its reach dims."),
			LegendRow(LegendSample.MOMENT, FlowFacts(FlowEnded.DONE, FlowHappened.NOW), "The replay's moment", "The same dot as the scrubber's."),
		),
	),
)
