package com.atelier_nyaarium.switchboard.plugins.references

import com.atelier_nyaarium.switchboard.hashContent
import com.atelier_nyaarium.switchboard.proto.RefFileMeta
import com.atelier_nyaarium.switchboard.proto.RefKeyMeta

internal sealed interface RefNow {
	/** No claim either way. */
	data object Unknown : RefNow

	data object Matches : RefNow

	/** `changed` holds line numbers in the now slice. */
	data class Differs(val startLine: Long, val lines: List<String>, val changed: Set<Long>) : RefNow
}

/** An inexact key's lines are a guess, so it is not compared. */
internal fun comparable(key: RefKeyMeta): Boolean =
	key.quality == "exact" && key.symbolId != null && key.spanHash != null && key.symbolStartLine != null

/** The key's lines from the snapshot, or null when the snapshot does not hold all of them. */
internal fun sentLines(meta: RefFileMeta, key: RefKeyMeta, snapshot: String): List<String>? {
	val byLine = HashMap<Long, String>()
	for ((startLine, text) in snapshotSegments(meta, snapshot)) {
		text.split("\n").forEachIndexed { i, line -> byLine[startLine + i] = line }
	}
	return (key.startLine..key.endLine).map { byLine[it] ?: return null }
}

/**
 * The same slice the sender hashed, found at its offset inside the declaration where it sits now: `declared`
 * is that declaration's lines now, and `file` the whole file now. A slice reaching past the declaration's
 * end has changed, whatever text happens to follow it.
 */
internal fun refNow(key: RefKeyMeta, sent: List<String>?, declared: LongRange?, file: String?): RefNow {
	if (!comparable(key)) return RefNow.Unknown
	val sentHash = key.spanHash ?: return RefNow.Unknown
	val sentStart = key.symbolStartLine ?: return RefNow.Unknown
	if (declared == null || file == null || key.startLine < sentStart || key.endLine < key.startLine) return RefNow.Unknown
	val start = declared.first + (key.startLine - sentStart)
	val count = (key.endLine - key.startLine + 1).toInt()
	val slice = file.split("\n").drop((start - 1).toInt()).take(count)
	if (slice.isEmpty()) return RefNow.Unknown
	val inside = start + count - 1 <= declared.last
	if (inside && hashContent(slice.joinToString("\n")) == sentHash) return RefNow.Matches
	val changed = slice.indices.filter { sent?.getOrNull(it) != slice[it] }.map { start + it }.toSet()
	return RefNow.Differs(start, slice, changed)
}
