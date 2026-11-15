package com.atelier_nyaarium.switchboard.liveconsole

/** Twin of `scanHoles`. UTF-16 offsets, end-exclusive. */
sealed interface HolePart {
	val start: Int
	val end: Int

	data class Text(val text: String, override val start: Int, override val end: Int) : HolePart

	/** An unclosed hole runs to the end. */
	data class Hole(val source: String, override val start: Int, override val end: Int, val closed: Boolean) : HolePart
}

private val ESCAPED = setOf('{', '}', '\\')

/** Quoted strings hide braces. */
private fun holeEnd(text: String, open: Int): Int {
	var depth = 0
	var at = open
	while (at < text.length) {
		val c = text[at]
		if (c == '"' || c == '\'') {
			at++
			while (at < text.length && text[at] != c) at += if (text[at] == '\\') 2 else 1
			at++
			continue
		}
		if (c == '{') depth++
		if (c == '}' && --depth == 0) return at + 1
		at++
	}
	return -1
}

/** A lone `}` is text. */
fun scanHoles(text: String): List<HolePart> {
	val parts = mutableListOf<HolePart>()
	val run = StringBuilder()
	var runStart = 0
	var at = 0
	fun flush(end: Int) {
		if (end > runStart) parts += HolePart.Text(run.toString(), runStart, end)
		run.setLength(0)
	}
	while (at < text.length) {
		val c = text[at]
		val next = text.getOrNull(at + 1)
		if (c == '\\' && next != null && next in ESCAPED) {
			run.append(next)
			at += 2
			continue
		}
		if (c != '{') {
			run.append(c)
			at++
			continue
		}
		flush(at)
		val end = holeEnd(text, at)
		val closed = end != -1
		val stop = if (closed) end else text.length
		parts += HolePart.Hole(text.substring(at + 1, if (closed) stop - 1 else stop), at, stop, closed)
		at = stop
		runStart = at
	}
	flush(text.length)
	return parts
}
