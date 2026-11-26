package com.atelier_nyaarium.switchboard.liveconsole

/** Twin of `lexConsole`. */
enum class ConsoleTokenKind(val wire: String) {
	IDENT("ident"),
	NUMBER("number"),
	STRING("string"),
	KEYWORD("keyword"),
	PUNCT("punct"),
	OP("op"),
	ERROR("error"),
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
)

private val KEYWORDS = setOf("true", "false", "null")

/** Operators spelled as words. */
private val WORD_OPS = setOf("and", "or")
private val PUNCT = setOf('.', '(', ')', '[', ']', '{', '}', ',', ':', ';')
private val TWO_CHAR_OPS = setOf("==", "!=", "<=", ">=")
private val ONE_CHAR_OPS = setOf('!', '+', '-', '*', '/', '=', '<', '>')
private val ESCAPES = mapOf('n' to '\n', 't' to '\t', '\\' to '\\', '"' to '"', '\'' to '\'')

private fun isDigit(c: Char) = c in '0'..'9'

private fun isIdentStart(c: Char) = c in 'a'..'z' || c in 'A'..'Z' || c == '_'

private fun isIdentPart(c: Char) = isIdentStart(c) || isDigit(c)

// Match grammar whitespace.
private fun isSpace(c: Char) = c == ' ' || c == '\t' || c == '\n' || c == '\r'

/** Minus stays separate. */
fun lexConsole(source: String): List<ConsoleToken> {
	val tokens = mutableListOf<ConsoleToken>()
	var at = 0
	while (at < source.length) {
		val c = source[at]
		if (isSpace(c)) {
			at++
			continue
		}
		val start = at
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
			val value = StringBuilder()
			var closed = false
			while (at < source.length) {
				val ch = source[at]
				if (ch == c) {
					at++
					closed = true
					break
				}
				if (ch == '\\' && at + 1 < source.length) {
					val next = source[at + 1]
					value.append(ESCAPES[next] ?: next)
					at += 2
					continue
				}
				value.append(ch)
				at++
			}
			tokens += ConsoleToken(ConsoleTokenKind.STRING, source.substring(start, at), start, at, closed, value.toString())
			continue
		}
		val two = if (at + 2 <= source.length) source.substring(at, at + 2) else ""
		if (two in TWO_CHAR_OPS) {
			at += 2
			tokens += ConsoleToken(ConsoleTokenKind.OP, two, start, at)
			continue
		}
		at++
		val kind =
			when (c) {
				in PUNCT -> ConsoleTokenKind.PUNCT
				in ONE_CHAR_OPS -> ConsoleTokenKind.OP
				else -> ConsoleTokenKind.ERROR
			}
		tokens += ConsoleToken(kind, c.toString(), start, at)
	}
	return tokens
}
