package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer

/** The facts card: one row per drill-in, its value, and whether it opens. */

private const val NONE = "none"

private const val LOADING = "..."

private const val UNAVAILABLE = "unavailable"

internal data class FactRow(val entry: FacetEntry, val label: String, val value: String, val opens: Boolean)

internal sealed interface FactRows {
	data class Counted(val rows: List<FactRow>) : FactRows

	/** An older plugin: its numbers, nothing opens. */
	data class Legacy(val rows: List<FactRow>) : FactRows
}

internal val TYPE_KINDS: Set<String> = setOf("class", "interface", "struct", "enum")

/** Null when the plugin carries no facts at all. */
internal fun factRows(
	knowledge: WorkspaceKnowledgeAnswer,
	history: FacetState<WorkspaceFacetAnswer>?,
	now: Long,
): FactRows? {
	val facts = knowledge.facts ?: return null
	val counts = facts.counts ?: return FactRows.Legacy(
		listOf(
			plainRow(FacetEntry.MEMBERS, facts.members),
			plainRow(FacetEntry.REFERENCES, facts.references),
			plainRow(FacetEntry.USED_BY, facts.fanIn),
			plainRow(FacetEntry.USES, facts.fanOut),
			plainRow(FacetEntry.HIERARCHY, facts.supertypes + facts.subtypes),
		),
	)
	return FactRows.Counted(
		listOf(
			row(FacetEntry.MEMBERS, countOrNone(counts.members), counts.members > 0),
			row(FacetEntry.REFERENCES, referencesText(counts.uses, counts.useFiles), counts.uses > 0),
			row(
				FacetEntry.USED_BY,
				usedByText(counts.dependents, counts.dependentFiles),
				counts.dependents + counts.dependentFiles > 0,
			),
			row(FacetEntry.USES, symbolsText(counts.boundTargets), counts.boundTargets > 0),
			hierarchyRow(knowledge.symbolKind, counts.supertypes, counts.subtypes),
			row(FacetEntry.COMMENTS, countOrNone(counts.comments), counts.comments > 0),
			lastChangedRow(history, now),
		),
	)
}

private fun row(entry: FacetEntry, value: String, opens: Boolean) = FactRow(entry, entry.title, value, opens)

private fun plainRow(entry: FacetEntry, count: Long) = FactRow(entry, entry.title, countOrNone(count), false)

private fun countOrNone(count: Long): String = if (count == 0L) NONE else countText(count)

private fun referencesText(uses: Long, files: Long): String =
	when {
		uses == 0L -> NONE
		files <= 1L -> "$uses ${plural(uses, "use")}"
		else -> "$uses uses in $files files"
	}

private fun usedByText(symbols: Long, files: Long): String =
	when {
		symbols == 0L && files == 0L -> NONE
		symbols == 0L -> "$files ${plural(files, "file")}"
		files == 0L -> symbolsText(symbols)
		else -> "${symbolsText(symbols)}, $files ${plural(files, "file")}"
	}

private fun symbolsText(count: Long): String = if (count == 0L) NONE else "$count ${plural(count, "symbol")}"

private fun hierarchyRow(kind: String?, supertypes: Long, subtypes: Long): FactRow {
	val entry = FacetEntry.HIERARCHY
	if (kind == null || kind !in TYPE_KINDS) return FactRow(entry, entry.title, "not a type", false)
	if (supertypes == 0L && subtypes == 0L) return FactRow(entry, entry.title, NONE, false)
	val parts = buildList {
		if (supertypes > 0) add("$supertypes ${plural(supertypes, "supertype")}")
		if (subtypes > 0) add("$subtypes ${subtypeNoun(kind, subtypes)}")
	}
	return FactRow(entry, entry.title, parts.joinToString(", "), true)
}

private fun subtypeNoun(kind: String?, count: Long): String =
	if (kind == "interface") plural(count, "implementation") else plural(count, "subtype")

private fun lastChangedRow(history: FacetState<WorkspaceFacetAnswer>?, now: Long): FactRow {
	val entry = FacetEntry.HISTORY
	val (value, opens) = when (history) {
		null, FacetState.Loading -> LOADING to false
		is FacetState.Shown -> {
			val answer = history.value as? WorkspaceFacetAnswer.History
			val newest = answer?.commits?.firstOrNull()
			when {
				newest != null -> agoText(newest.at * 1_000, now) to true
				answer != null -> lastChangedWords(answer.outcome) to false
				else -> UNAVAILABLE to false
			}
		}
		else -> UNAVAILABLE to false
	}
	return FactRow(entry, entry.title, value, opens)
}

private fun lastChangedWords(outcome: String): String =
	when (outcome) {
		HISTORY_UNTRACKED -> "untracked"
		HISTORY_NOT_REPOSITORY -> "not in git"
		else -> NONE
	}
