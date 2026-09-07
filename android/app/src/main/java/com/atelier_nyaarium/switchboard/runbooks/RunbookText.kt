package com.atelier_nyaarium.switchboard.runbooks

private const val CHIP_HEAD = 40

internal fun summaryOf(text: String): String =
	text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: ""

/** First line, capped; marked when cut. */
internal fun chipLabel(option: String): String {
	val head = summaryOf(option)
	if (head == option.trim() && head.length <= CHIP_HEAD) return head
	// Never end on half a pair.
	val cut = head.take(CHIP_HEAD).let { if (it.isNotEmpty() && it.last().isHighSurrogate()) it.dropLast(1) else it }
	// A first line ending in a period would otherwise read as four dots.
	return "${cut.trimEnd().trimEnd('.')}..."
}

/** Blank edges go; indent stays. */
internal fun trimmedOption(text: String): String {
	val lines = text.lines().dropWhile { it.isBlank() }.dropLastWhile { it.isBlank() }
	if (lines.size <= 1) return lines.firstOrNull()?.trim() ?: ""
	return lines.joinToString("\n").trimEnd()
}
