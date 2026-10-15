package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeNote

internal data class NoteBadge(val text: String, val warning: Boolean)

internal fun noteBadges(note: WorkspaceKnowledgeNote): List<NoteBadge> =
	buildList {
		if (note.sourceChanged) add(NoteBadge("SOURCE CHANGED", warning = true))
		if (note.changedRefs > 0) add(NoteBadge(refsText(note.changedRefs, "CHANGED"), warning = true))
		if (note.brokenRefs > 0) add(NoteBadge(refsText(note.brokenRefs, "BROKEN"), warning = true))
	}

private fun refsText(count: Long, state: String): String = "${countText(count)} ${if (count == 1L) "REF" else "REFS"} $state"

internal fun kindBadge(symbolKind: String?): String =
	when (symbolKind) {
		"function", "method", "constructor", "operator" -> "F"
		"constant", "variable" -> "C"
		"interface", "typeParameter" -> "T"
		"class", "struct" -> "K"
		"property", "field" -> "P"
		"enum" -> "E"
		"module", "namespace", "package", "file" -> "M"
		"heading" -> "H"
		else -> symbolKind?.firstOrNull()?.uppercase() ?: "?"
	}
