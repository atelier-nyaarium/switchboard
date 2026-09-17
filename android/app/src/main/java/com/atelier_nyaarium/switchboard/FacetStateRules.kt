package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer

/** The state a plane answer reads as, the unit each facet counts in, and the notices they draw. */

internal sealed interface FacetState<out T> {
	data object Loading : FacetState<Nothing>

	data class Shown<T>(val value: T) : FacetState<T>

	data class TooLarge(val text: String) : FacetState<Nothing>

	/** `update` is version skew rather than something this workspace withholds. */
	data class Refused(val text: String, val update: Boolean) : FacetState<Nothing>

	data object Unreachable : FacetState<Nothing>
}

internal fun facetState(
	entry: FacetEntry,
	symbolId: String,
	answer: WorkspaceAnswer<WorkspaceListing<WorkspaceSymbolFacetAnswer>>?,
): FacetState<WorkspaceFacetAnswer> =
	when (answer) {
		null -> FacetState.Loading
		is WorkspaceAnswer.Refused -> refusalOf(answer.reason)
		WorkspaceAnswer.Unreachable -> FacetState.Unreachable
		is WorkspaceAnswer.Read -> when (val listing = answer.value) {
			is WorkspaceListing.TooLarge -> FacetState.TooLarge(tooLargeText(facetUnit(entry), listing.rows, listing.bytes))
			// Another symbol's or another facet's answer says nothing about this place.
			is WorkspaceListing.Listed ->
				if (listing.value.symbolId == symbolId && facetOf(listing.value.facet) == entry.facet) {
					FacetState.Shown(listing.value.facet)
				} else {
					FacetState.Unreachable
				}
		}
	}

internal fun fileHistoryState(
	path: String,
	answer: WorkspaceAnswer<WorkspaceListing<WorkspaceFileHistoryAnswer>>?,
): FacetState<WorkspaceFileHistoryAnswer> =
	when (answer) {
		null -> FacetState.Loading
		is WorkspaceAnswer.Refused -> refusalOf(answer.reason)
		WorkspaceAnswer.Unreachable -> FacetState.Unreachable
		is WorkspaceAnswer.Read -> when (val listing = answer.value) {
			is WorkspaceListing.TooLarge -> FacetState.TooLarge(tooLargeText(HISTORY_COMMITS, listing.rows, listing.bytes))
			is WorkspaceListing.Listed ->
				if (listing.value.path == path) FacetState.Shown(listing.value) else FacetState.Unreachable
		}
	}

private fun facetOf(answer: WorkspaceFacetAnswer): WorkspaceFacet =
	when (answer) {
		is WorkspaceFacetAnswer.Uses -> WorkspaceFacet.Uses
		is WorkspaceFacetAnswer.UsesFrom -> WorkspaceFacet.UsesFrom
		is WorkspaceFacetAnswer.Members -> WorkspaceFacet.Members
		is WorkspaceFacetAnswer.Hierarchy -> WorkspaceFacet.Hierarchy
		is WorkspaceFacetAnswer.Comments -> WorkspaceFacet.Comments
		is WorkspaceFacetAnswer.History -> WorkspaceFacet.History
	}

internal fun facetUnit(entry: FacetEntry): String =
	when (entry) {
		FacetEntry.REFERENCES, FacetEntry.USED_BY -> "uses"
		FacetEntry.USES -> "references"
		FacetEntry.MEMBERS -> "members"
		FacetEntry.HIERARCHY -> "types"
		FacetEntry.COMMENTS -> "comments"
		FacetEntry.HISTORY -> HISTORY_COMMITS
	}

/** Without a size the rows are a floor: the plugin stopped counting. */
internal fun tooLargeText(unit: String, rows: Long, bytes: Long?): String {
	val counted = countText(rows)
	val size = prettySize(bytes) ?: return "$counted+ $unit"
	return "$counted $unit · $size"
}

/**
 * Nothing typed marks version skew, so the three refusals that mean it are read by their words:
 * the plugin's, Lexicon's, and an older Gateway answering with a schema issue array.
 */
internal fun refusalOf(reason: String): FacetState.Refused {
	val trimmed = reason.trim()
	return when {
		trimmed.contains("update", ignoreCase = true) -> FacetState.Refused("Update this session's plugin to see this", true)
		trimmed.startsWith("[") && trimmed.contains("\"code\"") -> FacetState.Refused("Update this Gateway to see this", true)
		else -> FacetState.Refused(reason, false)
	}
}
