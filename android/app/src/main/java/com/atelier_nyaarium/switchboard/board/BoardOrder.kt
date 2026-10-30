package com.atelier_nyaarium.switchboard.board

import com.atelier_nyaarium.switchboard.proto.BoardEntry

/**
 * Twin of src/shared/board-order.ts, pinned by tests/fixtures/board-order/vectors.json. A rank is
 * a sibling's 1-based position among its parent's live children; the Router stores it, and the
 * phone runs the same rule only to show a pending write.
 */
object BoardOrder {
	/** Sibling order. */
	val byRank = compareBy<BoardEntry>({ it.rank }, { it.id })

	/** Live siblings in order. */
	fun siblingsInOrder(entries: Collection<BoardEntry>, parent: String?, exclude: String? = null): List<BoardEntry> =
		entries.filter { it.parent == parent && it.trashedAt == null && it.id != exclude }.sortedWith(byRank)

	/** Rank for appending. */
	fun endRank(entries: Collection<BoardEntry>, parent: String?, exclude: String? = null): Long =
		(siblingsInOrder(entries, parent, exclude).maxOfOrNull { it.rank } ?: 0L) + 1

	/** Moves `id` under `parent` at `index` among the live siblings, the end when null, and numbers that group. */
	fun placeAt(entries: MutableMap<String, BoardEntry>, id: String, parent: String?, index: Int? = null) {
		val moved = entries[id]?.copy(parent = parent) ?: return
		// Trash keeps its rank.
		if (moved.trashedAt != null) {
			entries[id] = moved
			return
		}
		val group = siblingsInOrder(entries.values, parent, id).toMutableList()
		group.add((index ?: group.size).coerceIn(0, group.size), moved)
		group.forEachIndexed { i, e -> entries[e.id] = e.copy(rank = i + 1L) }
	}

	/** Brings back what a restore of `id` takes; the topmost lands last among its live siblings. */
	fun restoreAtEnd(entries: MutableMap<String, BoardEntry>, id: String): List<String> {
		val brought = restoreBrings(entries, id)
		for (at in brought) entries[at]?.let { entries[at] = it.copy(trashedAt = null) }
		brought.firstOrNull()?.let { top -> entries[top]?.let { placeAt(entries, top, it.parent) } }
		return brought
	}

	/** Numbers every group's live entries 1..n in order; answers the ids whose rank moved. */
	fun renumber(entries: MutableMap<String, BoardEntry>): Set<String> {
		val moved = mutableSetOf<String>()
		for (group in entries.values.filter { it.trashedAt == null }.groupBy { it.parent }.values) {
			group.sortedWith(byRank).forEachIndexed { i, e ->
				if (e.rank == i + 1L) return@forEachIndexed
				entries[e.id] = e.copy(rank = i + 1L)
				moved.add(e.id)
			}
		}
		return moved
	}
}
