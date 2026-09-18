package com.atelier_nyaarium.switchboard

/** Expands tabs for display only. */

internal const val TAB_WIDTH = 4

/** Expanded text and offset maps. */
internal class Expanded(
	val text: String,
	val toExpandedOffsets: IntArray,
	val toOriginalOffsets: IntArray,
) {
	/** Clamped to map bounds. */
	fun expandedOffset(original: Int): Int = toExpandedOffsets[original.coerceIn(0, toExpandedOffsets.lastIndex)]

	fun originalOffset(transformed: Int): Int = toOriginalOffsets[transformed.coerceIn(0, toOriginalOffsets.lastIndex)]
}

/** Tabs advance to the next stop. */
internal fun expandTabs(original: String): Expanded {
	if (original.indexOf('\t') < 0) {
		val identity = IntArray(original.length + 1) { it }
		return Expanded(original, identity, identity)
	}
	val expanded = StringBuilder()
	val toExpandedOffsets = IntArray(original.length + 1)
	val toOriginalOffsets = mutableListOf<Int>()
	var column = 0
	for (i in original.indices) {
		toExpandedOffsets[i] = expanded.length
		val c = original[i]
		val width = if (c == '\t') TAB_WIDTH - (column % TAB_WIDTH) else 1
		repeat(width) { toOriginalOffsets.add(i) }
		if (c == '\t') {
			repeat(width) { expanded.append(' ') }
			column += width
		} else {
			expanded.append(c)
			column = if (c == '\n') 0 else column + 1
		}
	}
	toExpandedOffsets[original.length] = expanded.length
	toOriginalOffsets.add(original.length)
	return Expanded(expanded.toString(), toExpandedOffsets, toOriginalOffsets.toIntArray())
}
