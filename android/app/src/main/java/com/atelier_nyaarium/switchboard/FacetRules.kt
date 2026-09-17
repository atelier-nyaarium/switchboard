package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacet
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import com.atelier_nyaarium.switchboard.proto.WorkspaceFileHistoryAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceHistoryCommit
import com.atelier_nyaarium.switchboard.proto.WorkspaceKnowledgeAnswer
import com.atelier_nyaarium.switchboard.proto.WorkspaceSymbolFacetAnswer
import java.util.Locale

/**
 * Every drill-in decision, outside a Composable so a gate can reach it: the Facts rows and their
 * units, grouping and order, role chips, the hierarchy column, comments, history, and the detail's
 * item order.
 */

private const val NONE = "none"

private const val LOADING = "..."

private const val UNAVAILABLE = "unavailable"

private const val UNKNOWN = "unknown"

private const val FILE_LEVEL = "file level"

private const val HISTORY_COMMITS = "commits"

private const val HISTORY_UNTRACKED = "untracked"

private const val HISTORY_NOT_REPOSITORY = "notRepository"

private const val HISTORY_NONE = "none"

private const val STATUS_BOUND = "bound"

private const val STATUS_AMBIGUOUS = "ambiguous"

////////////////////////////////
//  Facts

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

////////////////////////////////
//  Facet states

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

////////////////////////////////
//  Uses

internal enum class UseGrouping { BY_SYMBOL, BY_FILE }

internal fun initialGrouping(entry: FacetEntry): UseGrouping =
	if (entry == FacetEntry.REFERENCES) UseGrouping.BY_FILE else UseGrouping.BY_SYMBOL

internal enum class RoleTone { PLAIN, HERITAGE }

internal data class RoleChip(val role: String?, val label: String, val count: Int)

private val ROLE_ORDER = listOf("typeUse", "call", "read", "write", "instantiate", "extends", "implements")

private const val UNNAMED_ROLE = "Use"

/** A role the answer leaves blank still needs a word, or its chip draws empty. */
internal fun roleLabel(role: String): String =
	when (role) {
		"typeUse" -> "Type"
		"call" -> "Call"
		"read" -> "Read"
		"write" -> "Write"
		"extends" -> "Extends"
		"implements" -> "Implements"
		"instantiate" -> "New"
		else -> role.ifBlank { UNNAMED_ROLE }.replaceFirstChar { it.uppercase() }
	}

internal fun roleTone(role: String): RoleTone =
	if (role == "extends" || role == "implements") RoleTone.HERITAGE else RoleTone.PLAIN

/** Empty under two roles: one chip filters nothing. */
internal fun roleChips(rows: List<WorkspaceFacetUse>): List<RoleChip> {
	val counted = rows.groupingBy { it.role }.eachCount()
	if (counted.size < 2) return emptyList()
	val chips = counted.entries
		.sortedWith(
			compareByDescending<Map.Entry<String, Int>> { it.value }
				.thenBy { roleOrdinal(it.key) }
				.thenBy { it.key },
		)
		.map { RoleChip(it.key, roleLabel(it.key), it.value) }
	return listOf(RoleChip(null, "All", rows.size)) + chips
}

private fun roleOrdinal(role: String): Int = ROLE_ORDER.indexOf(role).takeIf { it >= 0 } ?: ROLE_ORDER.size

internal sealed interface UseItem {
	val key: String

	data class Header(
		override val key: String,
		val title: String,
		val kind: String?,
		val where: String?,
		val count: Int,
		val opens: DetailOpen?,
		/** Why a target is not a symbol. */
		val outside: String?,
	) : UseItem {
		/** Without a kind the title is a path or an unheld name, drawn as written rather than as a name. */
		val declaration: Boolean get() = kind != null
	}

	data class Row(
		override val key: String,
		val label: String,
		val role: String,
		val tone: RoleTone,
		val line: Long,
		val use: WorkspaceFacetUse,
		val opens: DetailOpen?,
	) : UseItem
}

internal data class DetailOpen(val symbolId: String, val module: String, val name: String, val reached: Reached? = null)

private val USE_ORDER = compareBy<WorkspaceFacetUse>({ it.line }, { it.startColumn }, { it.endColumn }, { it.role })

/** A null role is every row. Groups a filter empties are dropped, and counts are the kept rows. */
internal fun useItems(rows: List<WorkspaceFacetUse>, grouping: UseGrouping, role: String?): List<UseItem> {
	val kept = if (role == null) rows else rows.filter { it.role == role }
	val groups = kept.groupBy { groupKeyOf(it, grouping) }
	val ordered = when (grouping) {
		UseGrouping.BY_SYMBOL -> groups.entries.sortedWith(
			compareByDescending<Map.Entry<String, List<WorkspaceFacetUse>>> { it.value.size }
				.thenBy { groupTitle(it.value.first(), grouping).lowercase(Locale.ROOT) }
				.thenBy { it.value.first().let { use -> use.topLevel?.module ?: use.module } }
				.thenBy { it.value.first().topLevel?.startLine ?: 0L },
		)
		UseGrouping.BY_FILE -> groups.entries.sortedBy { it.key }
	}
	val keys = KeyMint()
	return ordered.flatMap { (groupKey, uses) ->
		listOf(useHeader(groupKey, uses, grouping)) + uses.sortedWith(USE_ORDER).map { useRow(it, grouping, keys) }
	}
}

private fun groupKeyOf(use: WorkspaceFacetUse, grouping: UseGrouping): String =
	if (grouping == UseGrouping.BY_SYMBOL) use.topLevel?.symbolId ?: use.module else use.module

private fun groupTitle(use: WorkspaceFacetUse, grouping: UseGrouping): String =
	if (grouping == UseGrouping.BY_SYMBOL) use.topLevel?.name ?: use.module else use.module

private fun useHeader(groupKey: String, uses: List<WorkspaceFacetUse>, grouping: UseGrouping): UseItem.Header {
	val key = "g:" + separated(grouping.name, groupKey)
	val top = uses.first().topLevel?.takeIf { grouping == UseGrouping.BY_SYMBOL }
		?: return UseItem.Header(key, groupTitle(uses.first(), grouping), null, null, uses.size, null, null)
	return UseItem.Header(
		key = key,
		title = top.name,
		kind = top.symbolKind,
		where = whereOf(top),
		count = uses.size,
		opens = DetailOpen(top.symbolId, top.module, top.name),
		outside = null,
	)
}

private fun useRow(use: WorkspaceFacetUse, grouping: UseGrouping, keys: KeyMint): UseItem.Row =
	rowOf(use, useLabel(use, grouping), keys, Reached(use.name, roleLabel(use.role), use.line))

private fun rowOf(use: WorkspaceFacetUse, label: String, keys: KeyMint, reached: Reached): UseItem.Row {
	val holder = use.holder ?: use.topLevel
	return UseItem.Row(
		key = keys.unique("u:" + separated(use.module, "${use.line}:${use.startColumn}:${use.endColumn}:${use.role}")),
		label = label,
		role = roleLabel(use.role),
		tone = roleTone(use.role),
		line = use.line,
		use = use,
		opens = holder?.let { DetailOpen(it.symbolId, it.module, it.name, reached) },
	)
}

private fun useLabel(use: WorkspaceFacetUse, grouping: UseGrouping): String {
	val holder = use.holder
	val top = use.topLevel
	return when (grouping) {
		UseGrouping.BY_SYMBOL -> when {
			holder == null -> FILE_LEVEL
			// A multi-line header can mislabel, so the declaration is only its first line.
			top != null && holder.symbolId == top.symbolId -> if (use.line == top.startLine) "declaration" else "body"
			else -> holder.name
		}
		UseGrouping.BY_FILE -> when {
			holder == null && top == null -> FILE_LEVEL
			holder == null -> top!!.name
			top == null || holder.symbolId == top.symbolId -> holder.name
			else -> "${top.name}.${holder.name}"
		}
	}
}

private fun whereOf(symbol: WorkspaceFacetSymbol): String = whereText(symbol.module, symbol.startLine)

/**
 * A second use at one position gets its own key, or the list draws one row for two. The MINTED key is
 * what is checked, since a base can already read as another base's suffixed key.
 */
private class KeyMint {
	private val minted = mutableSetOf<String>()

	fun unique(base: String): String {
		var at = 1
		var key = base
		while (!minted.add(key)) {
			at++
			key = "$base:$at"
		}
		return key
	}
}

////////////////////////////////
//  Uses from

internal fun targetItems(targets: List<WorkspaceFacetTarget>): List<UseItem> {
	val ordered = targets.sortedWith(
		compareBy<WorkspaceFacetTarget> { targetRank(it) }
			.thenByDescending { it.uses.size }
			.thenBy { targetTitle(it).lowercase(Locale.ROOT) },
	)
	val keys = KeyMint()
	return ordered.flatMap { target ->
		listOf(targetHeader(target)) + target.uses.sortedWith(USE_ORDER).map { targetRow(target, it, keys) }
	}
}

private fun targetRank(target: WorkspaceFacetTarget): Int =
	when {
		target.status == STATUS_BOUND && target.target != null -> 0
		target.status == STATUS_AMBIGUOUS -> 1
		else -> 2
	}

private fun targetTitle(target: WorkspaceFacetTarget): String = target.target?.name ?: target.name

private fun targetHeader(target: WorkspaceFacetTarget): UseItem.Header {
	val key = "t:" + separated(target.status, target.name)
	val bound = target.target?.takeIf { targetRank(target) == 0 }
		?: return UseItem.Header(key, target.name, null, null, target.uses.size, null, outsideText(target))
	return UseItem.Header(
		key = key,
		title = bound.name,
		kind = bound.symbolKind,
		where = whereOf(bound),
		count = target.uses.size,
		opens = DetailOpen(bound.symbolId, bound.module, bound.name),
		outside = null,
	)
}

private fun outsideText(target: WorkspaceFacetTarget): String =
	when {
		target.status == STATUS_AMBIGUOUS -> "ambiguous"
		target.reason == "ExternalDependency" || target.reason == "NotIndexed" -> "not indexed"
		else -> "unresolved"
	}

private fun targetRow(target: WorkspaceFacetTarget, use: WorkspaceFacetUse, keys: KeyMint): UseItem.Row =
	rowOf(use, use.holder?.name ?: FILE_LEVEL, keys, Reached(targetTitle(target), roleLabel(use.role), use.line))

internal fun usesSubtitle(rows: List<WorkspaceFacetUse>): String {
	if (rows.isEmpty()) return NONE
	val symbols = rows.mapNotNull { it.topLevel?.symbolId }.distinct().size
	val files = rows.map { it.module }.distinct().size
	return "${countText(rows.size)} ${plural(rows.size, "use")} in ${countText(symbols)} ${plural(symbols, "symbol")}, " +
		"${countText(files)} ${plural(files, "file")}"
}

internal fun targetsSubtitle(targets: List<WorkspaceFacetTarget>): String {
	if (targets.isEmpty()) return NONE
	val ranked = targets.groupingBy { targetRank(it) }.eachCount()
	val bound = ranked[0] ?: 0
	val ambiguous = ranked[1] ?: 0
	val unbound = ranked[2] ?: 0
	val parts = buildList {
		add("${countText(bound)} ${plural(bound, "symbol")}")
		if (ambiguous > 0) add("${countText(ambiguous)} ambiguous")
		if (unbound > 0) add("${countText(unbound)} ${plural(unbound, "name")} outside the index")
	}
	if (parts.size == 1) return parts.single()
	return parts.dropLast(1).joinToString(", ") + ", and " + parts.last()
}

////////////////////////////////
//  Members

internal fun memberChips(members: List<WorkspaceFacetSymbol>): List<OutlineKind> =
	kindChips(members.map { it.symbolKind }).takeIf { it.size > 2 } ?: emptyList()

/** A null kind is every member, as the outline's own chips read. */
internal fun membersOfKind(members: List<WorkspaceFacetSymbol>, kind: String?): List<WorkspaceFacetSymbol> =
	if (kind == null) members else members.filter { it.symbolKind == kind }

internal fun membersSubtitle(members: List<WorkspaceFacetSymbol>): String {
	val kinds = members.map { it.symbolKind }.distinct()
	val noun = if (kinds.size == 1) kindNoun(kinds.single(), members.size) else plural(members.size, "member")
	return "${countText(members.size)} $noun, in source order"
}

internal fun kindNoun(kind: String, count: Int): String =
	when (kind) {
		"property" -> if (count == 1) "property" else "properties"
		"class" -> if (count == 1) "class" else "classes"
		"method", "function", "field", "constructor", "interface", "enum", "struct", "constant", "variable" ->
			plural(count, kind)
		else -> plural(count, "member")
	}

////////////////////////////////
//  Hierarchy

internal sealed interface TypeNode {
	val key: String

	data class Known(
		override val key: String,
		val symbolId: String,
		val module: String,
		val name: String,
		val kind: String?,
		val startLine: Long?,
		val tag: String?,
		val self: Boolean = false,
		val opens: Boolean = true,
	) : TypeNode

	data class Unbound(override val key: String, val name: String, val tag: String?) : TypeNode
}

internal data class HierarchyColumn(val above: List<TypeNode>, val self: TypeNode.Known, val below: List<TypeNode>)

/** Farthest ancestor first, down to the symbol, then what descends from it. */
internal fun hierarchyColumn(answer: WorkspaceFacetAnswer.Hierarchy): HierarchyColumn {
	val subject = answer.subject
	return HierarchyColumn(
		above = answer.ancestors.reversed().map { knownNode("a:", it, it.symbolKind) } +
			answer.supertypes.map { knownNode("s:", it.symbol, it.role ?: it.symbol.symbolKind) } +
			answer.unbound.map { TypeNode.Unbound("x:${it.name}", it.name, it.role) },
		self = TypeNode.Known(
			key = "self",
			symbolId = subject.symbolId,
			module = subject.module,
			name = subject.name,
			kind = subject.symbolKind,
			startLine = subject.startLine,
			tag = subject.symbolKind,
			self = true,
			opens = false,
		),
		below = answer.subtypes.map { knownNode("b:", it.symbol, it.role ?: it.symbol.symbolKind) },
	)
}

private fun knownNode(prefix: String, symbol: WorkspaceFacetSymbol, tag: String?) =
	TypeNode.Known(
		key = prefix + symbol.symbolId,
		symbolId = symbol.symbolId,
		module = symbol.module,
		name = symbol.name,
		kind = symbol.symbolKind,
		startLine = symbol.startLine,
		tag = tag,
	)

////////////////////////////////
//  Comments

internal data class TextPart(val text: String, val code: Boolean)

internal data class CommentItem(
	val key: String,
	val form: String,
	val holder: String?,
	val line: Long,
	val parts: List<TextPart>,
	val opens: DetailOpen?,
)

internal fun commentItems(answer: WorkspaceFacetAnswer.Comments): List<CommentItem> =
	answer.comments.sortedBy { it.line }.mapIndexed { index, comment ->
		val form = comment.form.uppercase(Locale.ROOT)
		CommentItem(
			key = "c:${comment.line}:$index",
			form = form,
			holder = comment.holder?.name,
			line = comment.line,
			parts = textParts(comment.text),
			opens = comment.holder?.let {
				DetailOpen(it.symbolId, it.module, it.name, Reached("Comment", form, comment.line))
			},
		)
	}

/** Backticks pair; an unmatched one stays text. */
internal fun textParts(text: String): List<TextPart> {
	val parts = mutableListOf<TextPart>()
	var at = 0
	while (at < text.length) {
		val open = text.indexOf('`', at)
		if (open < 0) break
		val close = text.indexOf('`', open + 1)
		if (close < 0) break
		if (open > at) parts.add(TextPart(text.substring(at, open), false))
		if (close > open + 1) parts.add(TextPart(text.substring(open + 1, close), true))
		at = close + 1
	}
	if (at < text.length) parts.add(TextPart(text.substring(at), false))
	return parts
}

internal fun commentsSubtitle(answer: WorkspaceFacetAnswer.Comments): String =
	if (answer.truncated == true) {
		"first ${countText(answer.comments.size)} inside it"
	} else {
		"${countText(answer.total)} inside it"
	}

////////////////////////////////
//  History

internal data class CommitItem(val key: String, val shortHash: String, val subject: String, val age: String)

/** Where the plugin stops a symbol's history. Pinned to its own bound by a residue test. */
internal const val HISTORY_COMMIT_CAP = 200

internal sealed interface HistoryBody {
	/** `stoppedAt` is the cap the plugin cut at, never the rows it happened to answer with. */
	data class Commits(val items: List<CommitItem>, val stoppedAt: Int?) : HistoryBody

	data class Empty(val text: String) : HistoryBody
}

internal fun historyBody(
	outcome: String,
	commits: List<WorkspaceHistoryCommit>,
	truncated: Boolean,
	now: Long,
): HistoryBody {
	if (outcome != HISTORY_COMMITS || commits.isEmpty()) return HistoryBody.Empty(historyWords(outcome))
	return HistoryBody.Commits(
		commits.map { CommitItem(it.hash, it.hash.take(7), it.subject, agoText(it.at * 1_000, now)) },
		HISTORY_COMMIT_CAP.takeIf { truncated },
	)
}

private fun historyWords(outcome: String): String =
	when (outcome) {
		HISTORY_UNTRACKED -> "Untracked"
		HISTORY_NOT_REPOSITORY -> "Not a repository"
		HISTORY_COMMITS, HISTORY_NONE -> "No commits"
		else -> "No history"
	}

internal fun historySubtitle(module: String, startLine: Long, endLine: Long): String {
	val file = module.substringAfterLast('/')
	return if (startLine == endLine) "$file, line $startLine" else "$file, lines $startLine-$endLine"
}

internal data class FileStats(
	val sinceLast: String,
	val commits: String,
	val commitsLabel: String,
	val added: String,
	val removed: String,
)

internal sealed interface FileStrip {
	data class Stats(val stats: FileStats) : FileStrip

	data class Line(val text: String) : FileStrip
}

internal fun fileStrip(answer: WorkspaceFileHistoryAnswer, now: Long): FileStrip {
	if (answer.outcome != HISTORY_COMMITS) return FileStrip.Line(historyWords(answer.outcome))
	return FileStrip.Stats(
		FileStats(
			sinceLast = answer.lastTouched?.let { spanText(now - it * 1_000) } ?: UNKNOWN,
			commits = "${answer.count}" + if (answer.truncated) "+" else "",
			commitsLabel = answer.firstSeen?.let { "commits in ${spanText(now - it * 1_000)}" } ?: HISTORY_COMMITS,
			added = "+${answer.added}",
			removed = "-${answer.removed}",
		),
	)
}

////////////////////////////////
//  Time

private const val MINUTE = 60_000L

private const val HOUR = 60 * MINUTE

private const val DAY = 24 * HOUR

/** A future instant reads as now rather than counting backwards. */
internal fun agoText(atMillis: Long, nowMillis: Long): String = bucketOf(nowMillis - atMillis)?.let { "$it ago" } ?: "just now"

internal fun spanText(ms: Long): String = bucketOf(ms) ?: "moments"

private fun bucketOf(ms: Long): String? {
	if (ms < MINUTE) return null
	val days = ms / DAY
	return when {
		ms < HOUR -> "${ms / MINUTE} min"
		ms < DAY -> counted(ms / HOUR, "hour")
		days < 14 -> counted(days, "day")
		days < 56 -> counted(days / 7, "week")
		days < 365 -> counted(days / 30, "month")
		else -> counted(days / 365, "year")
	}
}

private fun counted(count: Long, word: String): String = "${countText(count)} ${plural(count, word)}"

private fun plural(count: Long, word: String): String = if (count == 1L) word else "${word}s"

private fun plural(count: Int, word: String): String = plural(count.toLong(), word)

/** One reading of a count, so a subtitle and a refusal do not group digits differently. */
internal fun countText(count: Long): String = "%,d".format(Locale.ROOT, count)

internal fun countText(count: Int): String = countText(count.toLong())

/** One line reads as one line, never as a range of itself. */
internal fun whereText(module: String, startLine: Long?, endLine: Long? = null): String =
	when {
		startLine == null -> module
		endLine == null || endLine == startLine -> "$module : $startLine"
		else -> "$module : $startLine-$endLine"
	}

////////////////////////////////
//  Detail

internal sealed interface DetailItem {
	val key: String

	data object Header : DetailItem {
		override val key = "h"
	}

	data class ReachedCard(val reached: Reached) : DetailItem {
		override val key = "r"
	}

	data object Facts : DetailItem {
		override val key = "f"
	}

	data object Knowledge : DetailItem {
		override val key = "k"
	}

	data object Documentation : DetailItem {
		override val key = "d"
	}

	data object SourceTitle : DetailItem {
		override val key = "st"
	}

	data class SourceLine(val line: PaintedLine) : DetailItem {
		override val key = "src:${line.number}"
	}

	data class ShowAll(val lines: Int) : DetailItem {
		override val key = "all"
	}
}

internal fun detailItems(view: DetailView, reached: Reached?, whole: Boolean): List<DetailItem> {
	val knowledge = (view.knowledge as? WorkspaceAnswer.Read)?.value
	val source = (view.source as? WorkspaceAnswer.Read)?.value
	val documentation = knowledge?.documentation
	return buildList {
		add(DetailItem.Header)
		reached?.let { add(DetailItem.ReachedCard(it)) }
		add(DetailItem.Facts)
		add(DetailItem.Knowledge)
		if (!documentation.isNullOrBlank()) add(DetailItem.Documentation)
		// Always titled: the screen draws the read's own refusal under it.
		add(DetailItem.SourceTitle)
		if (source == null) return@buildList
		val painted = paintSource(source.text, source.spans, source.startLine)
		val window = sourceWindow(painted, reached?.line, whole)
		window.lines.forEach { add(DetailItem.SourceLine(it)) }
		if (window.hiddenAbove + window.hiddenBelow > 0) add(DetailItem.ShowAll(painted.size))
	}
}

internal fun reachedIndex(items: List<DetailItem>): Int? =
	items.indexOfFirst { it is DetailItem.SourceLine && it.line.marked }.takeIf { it >= 0 }
