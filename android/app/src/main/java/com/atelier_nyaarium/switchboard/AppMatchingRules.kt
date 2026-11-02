package com.atelier_nyaarium.switchboard

internal fun appMatches(label: String, packageName: String, query: String?): Boolean {
	val needle = query?.trim().orEmpty()
	if (needle.length > 80) return false
	return needle.isEmpty() || label.contains(needle, ignoreCase = true) || packageName.contains(needle, ignoreCase = true)
}
