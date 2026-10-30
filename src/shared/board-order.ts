////////////////////////////////
//  Sibling order on the task board
//
//  A rank is a sibling's 1-based position among its parent's LIVE children. Trash takes no part.
//  Only the Router stores ranks: a client names an index and the Router numbers the group, since
//  renumbering touches entries a session does not hold. `BoardOrder.kt` is the phone's twin,
//  pinned by tests/fixtures/board-order/vectors.json.

import { restoreBrings } from "./board-structure.js";
import type { BoardEntry } from "./console-protocol.js";

type Ordered = Pick<BoardEntry, "id" | "parent" | "rank" | "trashedAt">;

const byRank = (a: Ordered, b: Ordered) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Live siblings in order. */
export function siblingsInOrder<E extends Ordered>(
	entries: Iterable<E>,
	parent: string | undefined,
	exclude?: string,
): E[] {
	const out: E[] = [];
	for (const e of entries) if (e.parent === parent && e.trashedAt === undefined && e.id !== exclude) out.push(e);
	return out.sort(byRank);
}

/** Rank for appending. */
export function endRank(entries: Iterable<Ordered>, parent: string | undefined, exclude?: string): number {
	let last = 0;
	for (const e of siblingsInOrder(entries, parent, exclude)) last = Math.max(last, e.rank);
	return last + 1;
}

/** Moves `id` under `parent` at `index` among the live siblings, the end when absent, and numbers that group. */
export function placeAt(entries: Map<string, Ordered>, id: string, parent: string | undefined, index?: number): void {
	const moved = entries.get(id);
	if (!moved) return;
	if (parent === undefined) delete moved.parent;
	else moved.parent = parent;
	// Trash keeps its rank.
	if (moved.trashedAt !== undefined) return;
	const group = siblingsInOrder(entries.values(), parent, id);
	const at = index === undefined ? group.length : Math.max(0, Math.min(index, group.length));
	group.splice(at, 0, moved);
	group.forEach((e, i) => {
		e.rank = i + 1;
	});
}

/** Brings back what a restore of `id` takes; the topmost lands last among its live siblings. */
export function restoreAtEnd(entries: Map<string, BoardEntry>, id: string): string[] {
	const brought = restoreBrings(entries, id);
	for (const at of brought) delete (entries.get(at) as BoardEntry).trashedAt;
	const top = brought[0] === undefined ? undefined : entries.get(brought[0]);
	if (top) placeAt(entries, top.id, top.parent);
	return brought;
}

/** Numbers every group's live entries 1..n in order; answers the ids whose rank moved. */
export function renumber(entries: Map<string, Ordered>): Set<string> {
	const groups = new Map<string | undefined, Ordered[]>();
	for (const e of entries.values()) {
		if (e.trashedAt !== undefined) continue;
		const group = groups.get(e.parent);
		if (group) group.push(e);
		else groups.set(e.parent, [e]);
	}
	const moved = new Set<string>();
	for (const group of groups.values()) {
		group.sort(byRank).forEach((e, i) => {
			if (e.rank === i + 1) return;
			e.rank = i + 1;
			moved.add(e.id);
		});
	}
	return moved;
}
