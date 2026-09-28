import crypto from "node:crypto";
import type { BoardEntry } from "./console-protocol.js";

/** Board replies always carry `applied`. */
export type BoardReply = { applied: boolean } & Record<string, unknown>;

/** Validates a restored board replay row. */
export function isBoardReply(candidate: unknown): candidate is BoardReply {
	return (
		typeof candidate === "object" && candidate !== null && typeof (candidate as BoardReply).applied === "boolean"
	);
}

/** Board trash retention. */
export const BOARD_TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Board projection byte budget. */
export const MAX_PROJECTION_BYTES = 1_000_000;

/** Full boards refuse new entries. */
export const MAX_ENTRIES_PER_OWNER = 5000;

export function taskBoardPlaneName(ownerId: string): string {
	return `task-board:${ownerId}`;
}

/** The MCP create's entry id, derived from its private per-invocation operation id (the
 * codexAgentIdForOperation pattern), so an HTTP retry upserts the SAME entry instead of doubling.
 *
 * The SENDER is in the preimage because the id alone decides the replay: `createAtEnd` answers
 * "already there" on a matching id without a scope check, which is only sound while an id can come
 * from one caller. `operationId` is an ordinary wire field, so two senders presenting the same one
 * would otherwise converge on one entry and the second be told it created another's. */
export function boardEntryIdForOperation(from: string, operationId: string): string {
	const digest = crypto.createHash("sha256").update(`BOARD_ENTRY_V2\n${from}\n${operationId}`).digest("hex");
	return `bd_${digest.slice(0, 32)}`;
}

/** Returns a subtree in root-first order. */
export function subtreeIds(entries: Iterable<BoardEntry>, rootId: string): string[] {
	const children = new Map<string, string[]>();
	for (const e of entries) {
		if (!e.parent) continue;
		const list = children.get(e.parent);
		if (list) list.push(e.id);
		else children.set(e.parent, [e.id]);
	}
	const out: string[] = [];
	const seen = new Set<string>();
	const queue = [rootId];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		queue.push(...(children.get(id) ?? []));
	}
	return out;
}

/**
 * Which entries can be set aside without breaking the tree: those `eligible` accepts whose every live
 * child is also going. A parent whose child survives is KEPT, so no pass can leave a survivor pointing
 * at an entry that is no longer in any list.
 *
 * Eligibility alone is not enough, and that is the whole point: a done parent can easily own a child
 * that is unfinished, or finished but held by another session, and either one has to keep its parent.
 * Bad data with a parent cycle resolves to not-prunable rather than hanging.
 */
export function prunableSubtrees(
	entries: Map<string, BoardEntry>,
	eligible: (entry: BoardEntry) => boolean,
): Set<string> {
	const kids = new Map<string, BoardEntry[]>();
	for (const e of entries.values()) {
		if (e.parent === undefined || e.trashedAt !== undefined) continue;
		const list = kids.get(e.parent);
		if (list) list.push(e);
		else kids.set(e.parent, [e]);
	}
	const memo = new Map<string, boolean>();
	const visiting = new Set<string>();
	const canPrune = (e: BoardEntry): boolean => {
		const seen = memo.get(e.id);
		if (seen !== undefined) return seen;
		if (visiting.has(e.id)) return false;
		visiting.add(e.id);
		const result = eligible(e) && (kids.get(e.id) ?? []).every(canPrune);
		visiting.delete(e.id);
		memo.set(e.id, result);
		return result;
	};
	const out = new Set<string>();
	for (const e of entries.values()) {
		if (e.trashedAt === undefined && canPrune(e)) out.add(e.id);
	}
	return out;
}

/** A live entry never sits under a trashed parent. */
export function livesUnderTrash(parent: BoardEntry, childTrashedAt: number | undefined): boolean {
	return parent.trashedAt !== undefined && childTrashedAt === undefined;
}

/**
 * What a trash of `rootId` takes: it and every live descendant, root first. A live entry under a
 * trashed parent floats to the top of the board and holds that parent in trash forever.
 */
export function trashTakes(entries: Map<string, BoardEntry>, rootId: string): string[] {
	return subtreeIds(entries.values(), rootId).filter((id) => {
		const e = entries.get(id);
		return e !== undefined && e.trashedAt === undefined;
	});
}

/**
 * What a restore of `id` brings back: its trashed ancestors, so it lands where it was, then it and
 * every descendant trashed with it or later. One trashed earlier on its own stays, with its subtree.
 */
export function restoreBrings(entries: Map<string, BoardEntry>, id: string): string[] {
	const since = entries.get(id)?.trashedAt;
	if (since === undefined) return [];
	const up: string[] = [];
	const seen = new Set([id]);
	for (let at = entries.get(id)?.parent; at !== undefined && !seen.has(at); at = entries.get(at)?.parent) {
		seen.add(at);
		if (entries.get(at)?.trashedAt !== undefined) up.push(at);
	}
	const kids = new Map<string, string[]>();
	for (const e of entries.values()) {
		if (e.parent === undefined) continue;
		const list = kids.get(e.parent);
		if (list) list.push(e.id);
		else kids.set(e.parent, [e.id]);
	}
	const down: string[] = [];
	const queue = [id];
	while (queue.length > 0) {
		const at = queue.shift() as string;
		const trashedAt = entries.get(at)?.trashedAt;
		if (trashedAt === undefined || trashedAt < since || down.includes(at)) continue;
		down.push(at);
		queue.push(...(kids.get(at) ?? []));
	}
	return [...up.reverse(), ...down];
}

/**
 * Promote every entry whose parent is gone, and answer how many. The ONE owner of "no entry points
 * at a parent that is not there", which every consumer relies on: the route's list ships entries flat
 * and receivers rebuild the tree from parent pointers, so a dangling one silently regroups a row.
 *
 * Called after each of the two paths that can delete a parent out from under a survivor - the trash
 * sweep and a tolerant restore. The write paths REFUSE instead (`parent_missing`, `would_orphan`),
 * because a caller that can still fix its own batch should be told rather than quietly corrected.
 */
export function promoteOrphans(entries: Map<string, BoardEntry>): number {
	let promoted = 0;
	for (const e of entries.values()) {
		if (e.parent && !entries.has(e.parent)) {
			delete e.parent;
			promoted++;
		}
	}
	return promoted;
}

/**
 * Parents that just lost a live child, derived from pre/post rather than named by a caller.
 *
 * These are the only entries the cascade cannot reach on its own: the child was trashed, reparented
 * or deleted, so no walk up from it arrives here any more. Deriving it here rather than at the three
 * call sites is what stops a fourth way of detaching a child from silently skipping the rule.
 */
export function orphanedParents(
	prev: { revision: number; entries: Map<string, BoardEntry> },
	next: { revision: number; entries: Map<string, BoardEntry> },
	touched: ReadonlySet<string>,
): string[] {
	const out: string[] = [];
	for (const id of touched) {
		const before = prev.entries.get(id);
		if (!before || before.trashedAt !== undefined || before.parent === undefined) continue;
		const after = next.entries.get(id);
		const stillAChild = after !== undefined && after.trashedAt === undefined && after.parent === before.parent;
		if (!stillAChild) out.push(before.parent);
	}
	return out;
}
