// A secret an occurrence wanted and never got. Beside the occurrence, never a state of it: the
// gateway has learned that a request went unanswered, and nothing about whether the work went well.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";

export const AttentionSchema = z.object({
	routineId: z.string().min(1),
	/** The occurrence that asked, so the owner is told which run wanted it. */
	scheduledAt: z.number().int().nonnegative(),
	entryId: z.string().min(1),
	at: z.number().int().nonnegative(),
});

export type Attention = z.infer<typeof AttentionSchema>;

const AttentionsSchema = z.array(AttentionSchema);

export interface AttentionStoreDeps {
	store: DurableStore;
}

export function createAttentionStore(deps: AttentionStoreDeps) {
	const { store } = deps;
	let rows: Attention[] = AttentionsSchema.parse(store.load() ?? []);

	const commit = (next: Attention[]): boolean => {
		const previous = rows;
		rows = next;
		try {
			store.saveChecked(rows);
			return true;
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) return true;
			rows = previous;
			console.warn(`[routine] attention write failed: ${(error as Error).message}`);
			return false;
		}
	};

	const forRoutine = (routineId: string): Attention[] => rows.filter((row) => row.routineId === routineId);

	/** One row per occurrence and entry; asking again refreshes when rather than adding a second. */
	const note = (row: Attention): boolean => {
		const held = rows.find(
			(candidate) =>
				candidate.routineId === row.routineId &&
				candidate.scheduledAt === row.scheduledAt &&
				candidate.entryId === row.entryId,
		);
		return commit(held ? rows.map((candidate) => (candidate === held ? row : candidate)) : [...rows, row]);
	};

	/** Everything a routine wanted, when the routine goes or the owner settles its secrets. */
	const clear = (routineId: string): boolean => {
		const kept = rows.filter((row) => row.routineId !== routineId);
		return kept.length === rows.length ? true : commit(kept);
	};

	const sweep = (before: number): number => {
		const kept = rows.filter((row) => row.at >= before);
		const dropped = rows.length - kept.length;
		if (dropped > 0) commit(kept);
		return dropped;
	};

	return { forRoutine, note, clear, sweep };
}

export type AttentionStore = ReturnType<typeof createAttentionStore>;
