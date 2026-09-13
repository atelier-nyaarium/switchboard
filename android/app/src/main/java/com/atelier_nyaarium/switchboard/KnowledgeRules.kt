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

/** Only while it is sending; asking again is on purpose. */
internal fun askable(state: RequestState?): Boolean = state != RequestState.SENDING

internal fun askLabel(state: RequestState?): String =
	when (state) {
		null -> "Ask"
		RequestState.SENDING -> "Asking"
		RequestState.SENT -> "Asked"
		RequestState.FAILED -> "Retry"
	}

internal fun knowledgeRequest(target: WorkspaceTarget, symbolId: String, question: String): RequestKey =
	RequestKey(target.address, RequestKind.KNOWLEDGE, separated(symbolId, question))

internal fun knowledgeAsk(answer: WorkspaceKnowledgeAnswer, question: String): String {
	val name = answer.name ?: answer.symbolId
	val where = answer.module?.let { " in `$it`" } ?: ""
	return "Record Lexicon's `$question` answer for `$name`$where, citing the facts it rests on. Symbol id: `${answer.symbolId}`."
}

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
