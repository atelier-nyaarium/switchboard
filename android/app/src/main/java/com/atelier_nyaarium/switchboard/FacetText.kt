package com.atelier_nyaarium.switchboard

import java.util.Locale

/** One reading of a count, a plural, a location and an age, shared across the workspace surface. */

private const val MINUTE = 60_000L

private const val HOUR = 60 * MINUTE

private const val DAY = 24 * HOUR

/** A future instant reads as now rather than counting backwards. */
internal fun agoText(atMillis: Long, nowMillis: Long): String = bucketOf(nowMillis - atMillis)?.let { "$it ago" } ?: "just now"

internal fun spanText(ms: Long): String = bucketOf(ms) ?: "moments"

private fun bucketOf(ms: Long): String? {
	if (ms < MINUTE) return null
	val days = ms / DAY
	return when {
		ms < HOUR -> "${ms / MINUTE} min"
		ms < DAY -> counted(ms / HOUR, "hour")
		days < 14 -> counted(days, "day")
		days < 56 -> counted(days / 7, "week")
		days < 365 -> counted(days / 30, "month")
		else -> counted(days / 365, "year")
	}
}

private fun counted(count: Long, word: String): String = "${countText(count)} ${plural(count, word)}"

internal fun plural(count: Long, word: String): String = if (count == 1L) word else "${word}s"

internal fun plural(count: Int, word: String): String = plural(count.toLong(), word)

/** One reading of a count, so a subtitle and a refusal do not group digits differently. */
internal fun countText(count: Long): String = "%,d".format(Locale.ROOT, count)

internal fun countText(count: Int): String = countText(count.toLong())

/** One line reads as one line, never as a range of itself. */
internal fun whereText(module: String, startLine: Long?, endLine: Long? = null): String =
	when {
		startLine == null -> module
		endLine == null || endLine == startLine -> "$module : $startLine"
		else -> "$module : $startLine-$endLine"
	}
