package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeFacts

internal enum class KnowledgeBadge { THIN, STALE, DOUBTED, STRANDED }

internal data class KnowledgeRow(val question: String, val prose: String?, val badges: List<KnowledgeBadge>)

internal data class KnowledgeFact(val label: String, val count: Long)

/** Null from an older plugin. */
internal fun knowledgeRows(answer: WorkspaceKnowledgeAnswer): List<KnowledgeRow>? =
	answer.answers?.map { entry ->
		KnowledgeRow(
			question = entry.question,
			prose = entry.prose,
			badges = buildList {
				if (entry.thin == true) add(KnowledgeBadge.THIN)
				if (entry.stale == true) add(KnowledgeBadge.STALE)
				if (entry.doubted == true) add(KnowledgeBadge.DOUBTED)
				if (entry.stranded == true) add(KnowledgeBadge.STRANDED)
			},
		)
	}

internal fun knowledgeFacts(facts: WorkspaceKnowledgeFacts): List<KnowledgeFact> =
	listOf(
		KnowledgeFact("Members", facts.members),
		KnowledgeFact("References", facts.references),
		KnowledgeFact("Used by", facts.fanIn),
		KnowledgeFact("Uses", facts.fanOut),
		KnowledgeFact("Supertypes", facts.supertypes),
		KnowledgeFact("Subtypes", facts.subtypes),
		KnowledgeFact("Comments", facts.comments),
	)

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
