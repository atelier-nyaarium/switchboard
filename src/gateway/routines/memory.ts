// What a routine remembers between runs. Its own store, keyed by the routine's incarnation.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import { MAX_ROUTINE_MEMORY_BYTES } from "../../shared/schemasRoutine.js";

export const RoutineMemorySchema = z.object({
	/** The routine's incarnation, not its id: a recreated id must not inherit a dead routine's memory. */
	incarnation: z.string().min(1),
	text: z.string(),
	/** Bumped on every accepted write. A run files against the version it read. */
	version: z.number().int().positive(),
	at: z.number().int().nonnegative(),
});

export type RoutineMemory = z.infer<typeof RoutineMemorySchema>;

const MemoriesSchema = z.array(RoutineMemorySchema);

/**
 * Restore refuses what a write refuses, the rule the policy store keeps. An oversized row on disk is
 * a hand edit or a bug, and starting that routine's memory empty is the safe direction.
 */
const usable = (row: RoutineMemory): boolean => Buffer.byteLength(row.text, "utf8") <= MAX_ROUTINE_MEMORY_BYTES;

/**
 * One row per incarnation, enforced at restore the way the policy store enforces its own rules. The
 * array shape can express two rows for one incarnation; a reader taking the first and a writer
 * updating one would then disagree about what a routine remembers.
 */
const deduped = (rows: RoutineMemory[]): RoutineMemory[] => {
	const held = new Map<string, RoutineMemory>();
	for (const row of rows) {
		const previous = held.get(row.incarnation);
		if (!previous || row.version > previous.version) held.set(row.incarnation, row);
	}
	return [...held.values()];
};

export interface RoutineMemoryStoreDeps {
	store: DurableStore;
}

export function createRoutineMemoryStore(deps: RoutineMemoryStoreDeps) {
	const { store } = deps;
	let rows: RoutineMemory[] = deduped(MemoriesSchema.parse(store.load() ?? []).filter(usable));

	const commit = (next: RoutineMemory[]): boolean => {
		const previous = rows;
		rows = next;
		try {
			store.saveChecked(rows);
			return true;
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) return true;
			rows = previous;
			console.warn(`[routine] memory write failed: ${(error as Error).message}`);
			return false;
		}
	};

	/** Nothing remembered yet reads as empty at version zero, which no write can have produced. */
	const read = (incarnation: string): { text: string; version: number } => {
		const held = rows.find((row) => row.incarnation === incarnation);
		return held ? { text: held.text, version: held.version } : { text: "", version: 0 };
	};

	/**
	 * Replaces a routine's memory, refusing a write against a version that has moved. Answers the
	 * stored row, or null with what is held now so the caller can hand a session the truth to
	 * reconcile against.
	 */
	const write = (
		incarnation: string,
		text: string,
		base: number,
		at: number,
	): { ok: true; row: RoutineMemory } | { ok: false; current: { text: string; version: number } } => {
		const current = read(incarnation);
		if (current.version !== base) return { ok: false, current };
		const row: RoutineMemory = { incarnation, text, version: current.version + 1, at };
		const held = rows.find((candidate) => candidate.incarnation === incarnation);
		const next = held ? rows.map((candidate) => (candidate === held ? row : candidate)) : [...rows, row];
		return commit(next) ? { ok: true, row } : { ok: false, current };
	};

	/** Applied regardless of version, for the one filing a conflict already bounced. */
	const overwrite = (incarnation: string, text: string, at: number): RoutineMemory | null => {
		const current = read(incarnation);
		const row: RoutineMemory = { incarnation, text, version: current.version + 1, at };
		const held = rows.find((candidate) => candidate.incarnation === incarnation);
		const next = held ? rows.map((candidate) => (candidate === held ? row : candidate)) : [...rows, row];
		return commit(next) ? row : null;
	};

	/** What a routine remembered, when the routine goes. */
	const clear = (incarnation: string): boolean => {
		const kept = rows.filter((row) => row.incarnation !== incarnation);
		return kept.length === rows.length ? true : commit(kept);
	};

	/**
	 * Memory whose routine is gone. Deletion is root-first, so a failed clear leaves an orphan rather
	 * than runnable state; this is what collects it on a later tick.
	 */
	const sweepOrphans = (live: Set<string>): number => {
		const kept = rows.filter((row) => live.has(row.incarnation));
		const dropped = rows.length - kept.length;
		if (dropped > 0) commit(kept);
		return dropped;
	};

	return { read, write, overwrite, clear, sweepOrphans };
}

export type RoutineMemoryStore = ReturnType<typeof createRoutineMemoryStore>;
