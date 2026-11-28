package com.atelier_nyaarium.switchboard.liveconsole

import com.atelier_nyaarium.switchboard.proto.Protocol

/** Twin of the lexer in `live-console-grammar.ts`. */
enum class ConsoleTokenKind(val wire: String) {
	IDENT("ident"),
	NUMBER("number"),
	STRING("string"),
	KEYWORD("keyword"),
	PUNCT("punct"),
	OP("op"),
	ERROR("error"),
	COMMENT("comment"),
	NEWLINE("newline"),
}

/** A string's body in order. UTF-16 offsets, end-exclusive. */
sealed interface ConsoleStringPart {
	val start: Int
	val end: Int

	data class Text(val value: String, override val start: Int, override val end: Int) : ConsoleStringPart

	data class Escape(val value: String, override val start: Int, override val end: Int) : ConsoleStringPart

	/** An open placeholder runs to the end. */
	data class Placeholder(
		val tokens: List<ConsoleToken>,
		val closed: Boolean,
		override val start: Int,
		override val end: Int,
	) : ConsoleStringPart
}

/** UTF-16 offsets, end-exclusive. */
data class ConsoleToken(
	val kind: ConsoleTokenKind,
	val text: String,
	val start: Int,
	val end: Int,
	/** Strings carry this flag. */
	val closed: Boolean? = null,
	val value: String? = null,
	val parts: List<ConsoleStringPart>? = null,
)

private val KEYWORDS = setOf("true", "false", "null")

/** Operators spelled as words. */
private val WORD_OPS = setOf("and", "or")
private val PUNCT = setOf('.', '(', ')', '[', ']', '{', '}', ',', ':', ';')
private val TWO_CHAR_OPS = setOf("==", "!=", "<=", ">=")
private val ONE_CHAR_OPS = setOf('!', '+', '-', '*', '/', '=', '<', '>')

private val BODY_ESCAPES = mapOf('{' to "{", '}' to "}", '\\' to "\\")

private val QUOTED_ESCAPES = mapOf('n' to "\n", 't' to "\t", 'r' to "\r", '"' to "\"", '\'' to "'")

private fun isDigit(c: Char) = c in '0'..'9'

private fun isIdentStart(c: Char) = c in 'a'..'z' || c in 'A'..'Z' || c == '_'

private fun isIdentPart(c: Char) = isIdentStart(c) || isDigit(c)

// Match grammar whitespace.
private fun isSpace(c: Char) = c == ' ' || c == '\t' || c == '\n' || c == '\r'

private class Lexer(private val source: String, private val script: Boolean) {
	private var at = 0

	/** `bound`: inside a quoted string, ends at the line. */
	fun code(nest: Int, bound: Boolean): Pair<List<ConsoleToken>, Boolean> {
		val lines = script && nest == 0
		val tokens = mutableListOf<ConsoleToken>()
		var depth = 0
		while (at < source.length) {
			val c = source[at]
			if (bound && (c == '\n' || c == '\r')) return tokens to false
			if (c == '\n' && lines) {
				tokens += ConsoleToken(ConsoleTokenKind.NEWLINE, "\n", at, at + 1)
				at++
				continue
			}
			if (isSpace(c)) {
				at++
				continue
			}
			val start = at
			if (lines && c == '/' && source.getOrNull(start + 1) == '/') {
				val line = source.indexOf('\n', start)
				var end = if (line < 0) source.length else line
				if (source[end - 1] == '\r') end--
				tokens += ConsoleToken(ConsoleTokenKind.COMMENT, source.substring(start, end), start, end)
				at = end
				continue
			}
			if (isIdentStart(c)) {
				while (at < source.length && isIdentPart(source[at])) at++
				val text = source.substring(start, at)
				val kind = when (text) {
					in KEYWORDS -> ConsoleTokenKind.KEYWORD
					in WORD_OPS -> ConsoleTokenKind.OP
					else -> ConsoleTokenKind.IDENT
				}
				tokens += ConsoleToken(kind, text, start, at)
				continue
			}
			if (isDigit(c)) {
				while (at < source.length && isDigit(source[at])) at++
				if (at + 1 < source.length && source[at] == '.' && isDigit(source[at + 1])) {
					at++
					while (at < source.length && isDigit(source[at])) at++
				}
				tokens += ConsoleToken(ConsoleTokenKind.NUMBER, source.substring(start, at), start, at)
				continue
			}
			if (c == '"' || c == '\'') {
				at++
				val (parts, closed) = body(c, nest)
				val constant = parts.none { it is ConsoleStringPart.Placeholder }
				val value = if (constant) parts.joinToString("") { valueOf(it) } else null
				tokens += ConsoleToken(ConsoleTokenKind.STRING, source.substring(start, at), start, at, closed, value, parts)
				continue
			}
			if (nest > 0 && c == '}' && depth == 0) {
				at++
				return tokens to true
			}
			val two = if (start + 2 <= source.length) source.substring(start, start + 2) else ""
			if (two in TWO_CHAR_OPS) {
				at += 2
				tokens += ConsoleToken(ConsoleTokenKind.OP, two, start, at)
				continue
			}
			at++
			if (c == '{') depth++
			if (c == '}') depth--
			val kind = when (c) {
				in PUNCT -> ConsoleTokenKind.PUNCT
				in ONE_CHAR_OPS -> ConsoleTokenKind.OP
				else -> ConsoleTokenKind.ERROR
			}
			tokens += ConsoleToken(kind, c.toString(), start, at)
		}
		return tokens to (nest == 0)
	}

	fun body(quote: Char?, nest: Int): Pair<List<ConsoleStringPart>, Boolean> {
		val parts = mutableListOf<ConsoleStringPart>()
		var run = -1
		fun flush() {
			if (run >= 0) parts += ConsoleStringPart.Text(source.substring(run, at), run, at)
			run = -1
		}
		while (at < source.length) {
			val c = source[at]
			if (c == quote) {
				flush()
				at++
				return parts to true
			}
			// A quoted string never passes its line.
			if (quote != null && (c == '\n' || c == '\r')) break
			val next = source.getOrNull(at + 1)
			// Any other backslash is text.
			val escaped = when {
				c != '\\' || next == null -> null
				quote == null -> BODY_ESCAPES[next]
				else -> BODY_ESCAPES[next] ?: QUOTED_ESCAPES[next]
			}
			if (escaped != null) {
				flush()
				parts += ConsoleStringPart.Escape(escaped, at, at + 2)
				at += 2
				continue
			}
			if (c != '{') {
				if (run < 0) run = at
				at++
				continue
			}
			flush()
			val start = at
			at++
			if (nest >= Protocol.Wire.CONSOLE_STRING_NEST_MAX) {
				val brace = ConsoleToken(ConsoleTokenKind.ERROR, "{", start, start + 1)
				parts += ConsoleStringPart.Placeholder(listOf(brace), false, start, source.length)
				at = source.length
				return parts to false
			}
			val (tokens, closed) = code(nest + 1, quote != null)
			parts += ConsoleStringPart.Placeholder(tokens, closed, start, at)
		}
		flush()
		return parts to (quote == null)
	}
}

private fun valueOf(part: ConsoleStringPart): String =
	when (part) {
		is ConsoleStringPart.Text -> part.value
		is ConsoleStringPart.Escape -> part.value
		is ConsoleStringPart.Placeholder -> ""
	}

/** Minus stays separate. */
fun lexConsole(source: String): List<ConsoleToken> = Lexer(source, false).code(0, false).first

fun lexScript(source: String): List<ConsoleToken> = Lexer(source, true).code(0, false).first

fun lexConsoleText(text: String): List<ConsoleStringPart> = Lexer(text, false).body(null, 0).first

fun everyToken(tokens: List<ConsoleToken>): List<ConsoleToken> =
	tokens.flatMap { token ->
		listOf(token) + token.parts.orEmpty().filterIsInstance<ConsoleStringPart.Placeholder>().flatMap { everyToken(it.tokens) }
	}

private fun written(table: Map<Char, String>): Map<Char, String> =
	table.entries.associate { (letter, read) -> read.single() to "\\$letter" }

/** Between double quotes a single quote stands as it is. */
private val QUOTED_WRITTEN = written(QUOTED_ESCAPES) + written(BODY_ESCAPES) - '\''

fun quoteConsoleString(value: String): String =
	value.asIterable().joinToString("", "\"", "\"") { QUOTED_WRITTEN[it] ?: it.toString() }
