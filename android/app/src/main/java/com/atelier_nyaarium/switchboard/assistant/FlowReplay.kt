package com.atelier_nyaarium.switchboard.assistant

import com.atelier_nyaarium.switchboard.proto.AutomationLastRun

/** Run-relative step span. */
internal data class StepSpan(val start: Long, val end: Long?)

private const val BEAT_MS = 1_000L

/** Minimum open duration. */
internal const val REPLAY_MIN_GAP_MS = 400L

/** Maximum replay gap. */
internal const val REPLAY_MAX_GAP_MS = 1_500L

/** Fallback uses ordered beats. */
internal fun spansOf(run: AutomationLastRun): Map<String, StepSpan> {
	if (run.steps.isNotEmpty() && run.steps.all { it.startMs != null }) {
		return run.steps.associate { it.path to StepSpan(it.startMs!!, it.endMs) }
	}
	return run.steps.withIndex().associate { (at, step) ->
		val last = run.steps.withIndex().filter { it.value.path.startsWith("${step.path}.") }.maxOfOrNull { it.index } ?: at
		step.path to StepSpan(at * BEAT_MS, if (step.outcome != null) (last + 1) * BEAT_MS else null)
	}
}

internal enum class MarkKind { OPENS, RETRIES, CLOSES }

internal data class ReplayMark(val path: String, val kind: MarkKind, val real: Long)

/** A run played back, long gaps shortened. */
internal class FlowReplay(val run: AutomationLastRun) {
	private val spans = spansOf(run)
	val marks: List<ReplayMark>
	private val play: List<Long>

	/** Playback end time. */
	val length: Long

	init {
		// Tie order preserves nesting.
		val seq = mutableMapOf<Pair<String, Boolean>, Int>()
		val open = ArrayDeque<String>()
		var next = 0
		for (step in run.steps) {
			while (open.isNotEmpty() && !step.path.startsWith("${open.last()}.")) seq[open.removeLast() to false] = next++
			seq[step.path to true] = next++
			open.addLast(step.path)
		}
		while (open.isNotEmpty()) seq[open.removeLast() to false] = next++
		val retried = run.steps.associate { it.path to it.retriedMs }
		marks = spans.flatMap { (path, span) ->
			val end = span.end?.let { maxOf(it, span.start) }
			listOfNotNull(
				ReplayMark(path, MarkKind.OPENS, span.start),
				retried[path]?.let { ReplayMark(path, MarkKind.RETRIES, it.coerceIn(span.start, end ?: Long.MAX_VALUE)) },
				end?.let { ReplayMark(path, MarkKind.CLOSES, it) },
			)
		}.sortedWith(compareBy({ it.real }, { seq[it.path to (it.kind != MarkKind.CLOSES)] ?: 0 }, { it.kind }))
		val opened = mutableMapOf<String, Long>()
		val times = ArrayList<Long>(marks.size)
		marks.forEachIndexed { index, mark ->
			val before = if (index == 0) 0L else times[index - 1]
			val gap = if (index == 0) 0L else mark.real - marks[index - 1].real
			val base = before + if (gap == 0L) 0L else gap.coerceIn(REPLAY_MIN_GAP_MS, REPLAY_MAX_GAP_MS)
			val at = when (mark.kind) {
				MarkKind.OPENS, MarkKind.RETRIES -> base
				MarkKind.CLOSES -> maxOf(base, (opened[mark.path] ?: 0L) + REPLAY_MIN_GAP_MS)
			}
			if (mark.kind == MarkKind.OPENS) opened[mark.path] = at
			times += at
		}
		play = times
		length = (times.lastOrNull() ?: 0L) + REPLAY_MIN_GAP_MS
	}

	private fun appliedAt(moment: Long): Int = play.indexOfLast { it <= moment } + 1

	/** Playback run snapshot. */
	fun runAt(moment: Long): AutomationLastRun {
		if (moment >= length) return run
		val applied = marks.take(appliedAt(moment)).groupBy({ it.kind }, { it.path }).mapValues { it.value.toSet() }
		val of = { kind: MarkKind -> applied[kind].orEmpty() }
		val steps = run.steps.filter { it.path in of(MarkKind.OPENS) }.map { step ->
			if (step.path in of(MarkKind.CLOSES)) return@map step
			// Untimed: only a step still retrying says so.
			val retrying = if (step.retriedMs != null) step.path in of(MarkKind.RETRIES) else step.outcome == null && step.retrying == true
			step.copy(outcome = null, reason = null, side = null, retrying = retrying.takeIf { it })
		}
		return run.copy(steps = steps, running = true, active = null, inFlight = null)
	}

	/** Newest open step progress. */
	fun dotAt(moment: Long): Pair<String, Float>? {
		if (moment >= length) return null
		val count = appliedAt(moment)
		val openAt = mutableMapOf<String, Long>()
		for (index in 0 until count) {
			val mark = marks[index]
			when (mark.kind) {
				MarkKind.OPENS -> openAt[mark.path] = play[index]
				MarkKind.RETRIES -> Unit
				MarkKind.CLOSES -> openAt.remove(mark.path)
			}
		}
		val (path, from) = openAt.maxByOrNull { it.value } ?: return null
		val closes = marks.indices.firstOrNull { marks[it].path == path && marks[it].kind == MarkKind.CLOSES }?.let { play[it] } ?: length
		val fraction = ((moment - from).toFloat() / (closes - from).coerceAtLeast(1)).coerceIn(0f, 1f)
		return path to fraction
	}

	/** Run time at playback. */
	fun realAt(moment: Long): Long {
		if (marks.isEmpty()) return 0L
		val index = play.indexOfLast { it <= moment }.coerceAtLeast(0)
		val after = (index + 1).takeIf { it < marks.size } ?: return marks.last().real
		val span = (play[after] - play[index]).coerceAtLeast(1)
		val through = ((moment - play[index]).toFloat() / span).coerceIn(0f, 1f)
		return marks[index].real + ((marks[after].real - marks[index].real) * through).toLong()
	}
}

/** One automation's replay as its band holds it. */
internal data class Replaying(val id: String, val replay: FlowReplay, val moment: Long, val playing: Boolean) {
	/** Stops at the end. */
	fun advanced(by: Long): Replaying =
		(moment + by).let { if (it >= replay.length) copy(moment = replay.length, playing = false) else copy(moment = it) }

	/** Ended plays again from the start; else pause or resume. */
	fun toggled(): Replaying = if (moment >= replay.length) copy(moment = 0L, playing = true) else copy(playing = !playing)

	fun scrubbed(to: Long): Replaying = copy(moment = to.coerceIn(0L, replay.length), playing = false)

	companion object {
		fun of(id: String, run: AutomationLastRun): Replaying = Replaying(id, FlowReplay(run), 0L, true)
	}
}
