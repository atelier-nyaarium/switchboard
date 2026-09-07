package com.atelier_nyaarium.switchboard.runbooks

// Explicit whitespace class.
// Escape braces for ICU.
private val PLACEHOLDER_AT = Regex("""^\{\{[ \t\r\n]*([A-Za-z][A-Za-z0-9_]*)[ \t\r\n]*\}\}""")

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
