package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse

/**
 * Highlighted code as the phone draws it: the plugin's token list, the palette, and the paint from
 * wire spans to lines. No Compose here, so every rule is reachable from a JVM test.
 */

/** Ordinal is the wire contract with the plugin's CODE_TOKENS. Append only. */
internal enum class CodeToken(val wire: String) {
	KEYWORD("keyword"),
	TYPE("type"),
	FUNCTION("function"),
	BUILTIN("builtin"),
	STRING("string"),
	ESCAPE("escape"),
	INTERPOLATION("interpolation"),
	REGEXP("regexp"),
	NUMBER("number"),
	LITERAL("literal"),
	COMMENT("comment"),
	DOCTAG("doctag"),
	META("meta"),
	ATTRIBUTE("attribute"),
	PROPERTY("property"),
	VARIABLE("variable"),
	PARAMS("params"),
	OPERATOR("operator"),
	PUNCTUATION("punctuation"),
	TAG("tag"),
	NAME("name"),
	SELECTOR("selector"),
	SECTION("section"),
	BULLET("bullet"),
	EMPHASIS("emphasis"),
	STRONG("strong"),
	ADDITION("addition"),
	DELETION("deletion"),
	LINK("link"),
	QUOTE("quote"),
	CODE("code"),
	;

	companion object {
		/** Null past the end: a newer plugin's token paints plain. */
		fun of(code: Long): CodeToken? = if (code < 0 || code >= entries.size) null else entries[code.toInt()]
	}
}

internal data class TokenStyle(
	val argb: Long,
	val bold: Boolean = false,
	val italic: Boolean = false,
	val background: Long? = null,
)

internal object CodePalette {
	const val BACKGROUND: Long = 0xFF0D1117
	const val BORDER: Long = 0xFF30363D
	const val TEXT: Long = 0xFFC9D1D9
	const val LINE_NUMBER: Long = 0xFF6E7681
	const val MARK: Long = 0xFFD29922
	const val MARK_BAND: Long = 0x2ED29922
	const val USE_CARD: Long = 0xFF1B1920
	const val USE_BORDER: Long = 0xFF2A2731

	/**
	 * No else branch: a token added to the wire is a compile error here rather than a colour nobody
	 * chose.
	 */
	fun styleOf(token: CodeToken): TokenStyle =
		when (token) {
			CodeToken.KEYWORD, CodeToken.DOCTAG -> TokenStyle(0xFFFF7B72)
			CodeToken.TYPE, CodeToken.BUILTIN -> TokenStyle(0xFFFFA657)
			CodeToken.FUNCTION -> TokenStyle(0xFFD2A8FF)
			CodeToken.STRING, CodeToken.REGEXP, CodeToken.ESCAPE -> TokenStyle(0xFFA5D6FF)
			CodeToken.NUMBER,
			CodeToken.LITERAL,
			CodeToken.META,
			CodeToken.ATTRIBUTE,
			CodeToken.VARIABLE,
			CodeToken.OPERATOR,
			CodeToken.SELECTOR,
			-> TokenStyle(0xFF79C0FF)
			CodeToken.COMMENT, CodeToken.CODE -> TokenStyle(0xFF8B949E)
			CodeToken.NAME, CodeToken.QUOTE -> TokenStyle(0xFF7EE787)
			CodeToken.SECTION -> TokenStyle(0xFF1F6FEB, bold = true)
			CodeToken.BULLET -> TokenStyle(0xFFF2CC60)
			CodeToken.EMPHASIS -> TokenStyle(TEXT, italic = true)
			CodeToken.STRONG -> TokenStyle(TEXT, bold = true)
			CodeToken.ADDITION -> TokenStyle(0xFFAFF5B4, background = 0xFF033A16)
			CodeToken.DELETION -> TokenStyle(0xFFFFDCD7, background = 0xFF67060C)
			CodeToken.INTERPOLATION,
			CodeToken.PROPERTY,
			CodeToken.PARAMS,
			CodeToken.PUNCTUATION,
			CodeToken.TAG,
			CodeToken.LINK,
			-> TokenStyle(TEXT)
		}
}

/** Lines added and lines removed. */
internal data class DiffTint(val added: Long, val removed: Long)

/** Never one colour: a diff tile must tell added from removed. */
internal fun diffTint(dark: Boolean): DiffTint =
	if (dark) DiffTint(added = 0xFF9BD4A3, removed = 0xFFF2B8B5) else DiffTint(added = 0xFF1A7F37, removed = 0xFFB3261E)

/** Half open over its line's text. */
internal data class PaintRun(val start: Int, val end: Int, val token: CodeToken)

internal data class PaintedLine(
	/** Null on use rows and signatures. */
	val number: Long? = null,
	val text: String,
	val runs: List<PaintRun> = emptyList(),
	val marked: Boolean = false,
	/** Inclusive, underlined. */
	val hit: IntRange? = null,
)

internal const val SOURCE_PREVIEW_LINES = 40

internal const val REACHED_LEAD_LINES = 6

internal const val MAX_PAINT_COLUMNS = 512

/** What a phone row draws. */
internal const val USE_ROW_COLUMNS = 48

internal const val USE_ROW_LEAD = 24

/** Three ASCII dots, so the row's cut is greppable. */
private const val CLIP_MARK = "..."

/**
 * Wire triples to runs. Sorted and disjoint whatever arrives, since a painter that overlaps draws
 * one token over another.
 */
internal fun runsOf(text: String, triples: List<Long>?): List<PaintRun> {
	if (triples == null) return emptyList()
	val found = mutableListOf<PaintRun>()
	var index = 0
	// A trailing partial is ignored rather than guessed at.
	while (index + 2 < triples.size) {
		val start = triples[index]
		val length = triples[index + 1]
		val token = CodeToken.of(triples[index + 2])
		index += 3
		if (token == null || start < 0 || length <= 0 || start >= text.length) continue
		val end = minOf(text.length.toLong(), start + length)
		found.add(PaintRun(start.toInt(), end.toInt(), token))
	}
	found.sortBy { it.start }
	return disjoint(found)
}

private fun disjoint(sorted: List<PaintRun>): List<PaintRun> {
	val kept = mutableListOf<PaintRun>()
	var edge = 0
	for (run in sorted) {
		val start = maxOf(run.start, edge)
		if (run.end <= start) continue
		kept.add(if (start == run.start) run else run.copy(start = start))
		edge = run.end
	}
	return kept
}

/** A span's text, numbered as the file numbers it. */
internal fun paintSource(text: String, spans: List<List<Long>>?, firstLine: Long): List<PaintedLine> =
	text.split("\n").mapIndexed { index, raw ->
		// Triples already stop before the carriage return.
		val line = raw.removeSuffix("\r")
		cutAt(PaintedText(line, runsOf(line, spans?.getOrNull(index))), MAX_PAINT_COLUMNS)
			.let { PaintedLine(number = firstLine + index, text = it.text, runs = it.runs) }
	}

internal data class SourcePaint(val lines: List<PaintedLine>, val hiddenAbove: Int, val hiddenBelow: Int)

/**
 * What the detail draws: the declaration, or a window around the reached line once it sits past the
 * preview. A reached line the span does not hold marks nothing.
 */
internal fun sourceWindow(lines: List<PaintedLine>, reached: Long?, whole: Boolean): SourcePaint {
	val at = reached?.let { number -> lines.indexOfFirst { it.number == number }.takeIf { it >= 0 } }
	val marked = if (at == null) lines else lines.mapIndexed { i, line -> if (i == at) line.copy(marked = true) else line }
	if (whole) return SourcePaint(marked, 0, 0)
	val from = if (at == null || at < SOURCE_PREVIEW_LINES - REACHED_LEAD_LINES) 0 else at - REACHED_LEAD_LINES
	val to = minOf(marked.size, from + SOURCE_PREVIEW_LINES)
	return SourcePaint(marked.subList(from, to).toList(), from, marked.size - to)
}

/**
 * One reference's line. Indentation is dropped, the name underlined, and a name sitting far right
 * opens the row just before it rather than off the edge. A front cut carries its own mark, so the
 * text is the only record of one: dropped indentation is not a cut, and the plugin's own window is.
 */
internal fun useLinePaint(use: WorkspaceFacetUse): PaintedLine {
	val text = use.text ?: ""
	val offset = (use.textStart ?: 0L).toInt()
	val whole = PaintedText(text, runsOf(text, use.spans), hitOf(use, offset, text.length))
	var painted = dropLeading(whole, text.takeWhile { it == ' ' || it == '\t' }.length)
	var front = use.textStart != null
	val hit = painted.hit
	if (hit != null && hit.last + 1 > USE_ROW_COLUMNS) {
		val cut = maxOf(0, hit.first - USE_ROW_LEAD)
		if (cut > 0) {
			painted = dropLeading(painted, cut)
			front = true
		}
	}
	if (front) painted = prefixed(painted, CLIP_MARK)
	val cut = cutAt(painted, MAX_PAINT_COLUMNS)
	return PaintedLine(text = cut.text, runs = cut.runs, hit = cut.hit)
}

/** A member's first signature line, without the name the row already shows. */
internal fun signaturePaint(member: WorkspaceFacetSymbol): PaintedLine? {
	val first = (member.signature ?: return null).substringBefore('\n').removeSuffix("\r")
	if (first.isEmpty()) return null
	val whole = PaintedText(first, runsOf(first, member.signatureSpans?.getOrNull(0)))
	val named = if (member.name.isNotEmpty() && first.startsWith(member.name)) dropLeading(whole, member.name.length) else whole
	val cut = cutAt(named, MAX_PAINT_COLUMNS)
	if (cut.text.isEmpty()) return null
	return PaintedLine(text = cut.text, runs = cut.runs)
}

/** Text and everything positioned over it, so one shift moves them together. */
private data class PaintedText(val text: String, val runs: List<PaintRun>, val hit: IntRange? = null)

private fun hitOf(use: WorkspaceFacetUse, offset: Int, length: Int): IntRange? {
	val start = (use.startColumn - offset).coerceIn(0L, length.toLong()).toInt()
	val end = (use.endColumn - offset).coerceIn(0L, length.toLong()).toInt()
	return if (end <= start) null else start until end
}

private fun dropLeading(painted: PaintedText, cut: Int): PaintedText {
	if (cut <= 0) return painted
	val text = painted.text.substring(minOf(cut, painted.text.length))
	return PaintedText(text, shifted(painted.runs, -cut, text.length), moved(painted.hit, -cut, text.length))
}

private fun prefixed(painted: PaintedText, prefix: String): PaintedText {
	val shift = prefix.length
	val text = prefix + painted.text
	return PaintedText(text, shifted(painted.runs, shift, text.length), moved(painted.hit, shift, text.length))
}

private fun cutAt(painted: PaintedText, columns: Int): PaintedText {
	if (painted.text.length <= columns) return painted
	// Never between a surrogate pair, or the row ends in half a character.
	val at = if (painted.text[columns - 1].isHighSurrogate()) columns - 1 else columns
	val text = painted.text.take(at)
	return PaintedText(text, shifted(painted.runs, 0, at), moved(painted.hit, 0, at))
}

private fun shifted(runs: List<PaintRun>, by: Int, length: Int): List<PaintRun> =
	runs.mapNotNull { run ->
		val start = (run.start + by).coerceIn(0, length)
		val end = (run.end + by).coerceIn(0, length)
		if (end <= start) null else run.copy(start = start, end = end)
	}

private fun moved(hit: IntRange?, by: Int, length: Int): IntRange? {
	if (hit == null) return null
	val start = (hit.first + by).coerceIn(0, length)
	val end = (hit.last + 1 + by).coerceIn(0, length)
	return if (end <= start) null else start until end
}
