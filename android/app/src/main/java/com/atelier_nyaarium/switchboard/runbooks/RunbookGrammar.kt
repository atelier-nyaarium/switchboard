package com.atelier_nyaarium.switchboard.runbooks

/**
 * The twin of `placeholdersOf` in `src/shared/runbook-grammar.ts`, pinned by
 * `tests/fixtures/runbook-grammar/vectors.json`. Recognition only, since the render is the
 * gateway's.
 */
// Whitespace explicit, never `\s`: the runtimes cover different characters.
// Braces escaped for ICU, which refuses a bare `}`. Unit tests run on the JVM and cannot see it.
private val PLACEHOLDER_AT = Regex("""^\{\{[ \t\r\n]*([A-Za-z][A-Za-z0-9_]*)[ \t\r\n]*\}\}""")

/** Null when an opener names no parameter. */
fun placeholdersOf(body: String): List<String>? {
	val names = LinkedHashSet<String>()
	var at = 0
	while (at < body.length) {
		val open = body.indexOf("{{", at)
		if (open < 0) return names.toList()
		val match = PLACEHOLDER_AT.find(body.substring(open)) ?: return null
		names += match.groupValues[1]
		at = open + match.value.length
	}
	return names.toList()
}
