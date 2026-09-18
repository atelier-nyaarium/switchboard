package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.crypto.sha256Hex

/**
 * Syntax paint for the raw editor: a per-line span cache, adjusted on every keystroke and landed
 * against the plugin's answer. No Compose here, so every rule is reachable from a JVM test.
 */

internal const val RAW_PAINT_DEBOUNCE_MS = 250L

/** `lines[i]`: line i's triples, or null to draw it plain. One entry per line of `text`, always. */
internal data class RawPaint(val text: String, val lines: List<List<Long>?>)

internal fun plainPaint(text: String): RawPaint = RawPaint(text, List(text.split("\n").size) { null })

/**
 * Carries the last good paint across a keystroke: lines before and after the edited region keep
 * their spans, the latter shifted by the line-count change; the edited lines draw plain until the
 * next answer lands.
 */
internal fun adjustPaint(current: RawPaint, newText: String): RawPaint {
	if (current.text == newText) return current
	val old = current.text.split("\n")
	val new = newText.split("\n")
	val maxPrefix = minOf(old.size, new.size)
	var prefix = 0
	while (prefix < maxPrefix && old[prefix] == new[prefix]) prefix++
	val maxSuffix = maxPrefix - prefix
	var suffix = 0
	while (suffix < maxSuffix && old[old.size - 1 - suffix] == new[new.size - 1 - suffix]) suffix++
	val shift = old.size - new.size
	val lines = List(new.size) { i ->
		when {
			i < prefix -> current.lines.getOrNull(i)
			i >= new.size - suffix -> current.lines.getOrNull(i + shift)
			else -> null
		}
	}
	return RawPaint(newText, lines)
}

/**
 * Only while the text held now is the text the answer was computed from; a moved hash means the
 * owner typed since, and the answer is dropped. Null spans keep the paint as it stands, adjusted.
 */
internal fun landPaint(current: RawPaint, answerTextHash: String, answerSpans: List<List<Long>>?): RawPaint {
	if (sha256Hex(current.text) != answerTextHash) return current
	if (answerSpans == null) return current
	return RawPaint(current.text, List(current.text.split("\n").size) { answerSpans.getOrNull(it) })
}

/** The paint's runs at their offset in the whole text, for a transformation that styles it in place. */
internal fun paintRuns(paint: RawPaint): List<PaintRun> {
	val runs = mutableListOf<PaintRun>()
	var offset = 0
	for (line in paint.text.split("\n").withIndex()) {
		for (run in runsOf(line.value, paint.lines.getOrNull(line.index))) {
			runs += PaintRun(offset + run.start, offset + run.end, run.token)
		}
		offset += line.value.length + 1
	}
	return runs
}
