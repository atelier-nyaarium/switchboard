package com.atelier_nyaarium.switchboard

import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetSymbol
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetTarget
import com.atelier_nyaarium.switchboard.proto.WorkspaceFacetUse
import java.util.Locale

/** The use listings: how uses and the targets they reach group, order, label and key. */

private const val NONE = "none"

private const val FILE_LEVEL = "file level"

private const val STATUS_BOUND = "bound"

private const val STATUS_AMBIGUOUS = "ambiguous"

////////////////////////////////
//  Roles

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

////////////////////////////////
//  Uses

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

private val USE_ORDER = compareBy<WorkspaceFacetUse>({ it.line }, { it.startColumn }, { it.endColumn }, { it.role })

/** A null role is every row. Empty groups are dropped, and counts are the kept rows. */
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
