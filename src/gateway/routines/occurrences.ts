// One occurrence per routine and scheduled instant, and every move is a CAS from a named state.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import {
	canTransition,
	MISS_REASONS,
	OCCURRENCE_STATES,
	type OccurrenceState,
} from "../../shared/routine-occurrence.js";

export const OccurrenceSchema = z.object({
	routineId: z.string().min(1),
	/** Frozen when the occurrence was made, so a later zone change cannot move it. */
	scheduledAt: z.number().int().nonnegative(),
	/** The authorization window's end, not a transport timeout. */
	deadlineAt: z.number().int().nonnegative(),
	state: z.enum(OCCURRENCE_STATES),
	/** Bumped on every write, so a stale reader cannot act twice. */
	version: z.number().int().positive(),
	reason: z.enum(MISS_REASONS).optional(),
	/** The runbook revision this occurrence was prepared against. */
	preparedRevision: z.number().int().positive().optional(),
	/**
	 * What was rendered when it was prepared. Served back rather than rendered again, or a runbook
	 * edited on Tuesday would rewrite instructions issued on Monday.
	 */
	snapshot: z.string().optional(),
	/** The session it was bound to, resolved from the target policy at preparation. */
	team: z.string().optional(),
});

export type Occurrence = z.infer<typeof OccurrenceSchema>;

const OccurrencesSchema = z.array(OccurrenceSchema);

export function occurrenceId(routineId: string, scheduledAt: number): string {
	return `${routineId}:${scheduledAt}`;
}

export interface OccurrenceStoreDeps {
	store: DurableStore;
}

export function createOccurrenceStore(deps: OccurrenceStoreDeps) {
	const { store } = deps;
	let rows: Occurrence[] = OccurrencesSchema.parse(store.load() ?? []);

	const commit = (next: Occurrence[]): boolean => {
		const previous = rows;
		rows = next;
		try {
			store.saveChecked(rows);
			return true;
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) return true;
			rows = previous;
			console.warn(`[routine] occurrence write failed: ${(error as Error).message}`);
			return false;
		}
	};

	const at = (routineId: string, scheduledAt: number): Occurrence | undefined =>
		rows.find((row) => row.routineId === routineId && row.scheduledAt === scheduledAt);

	const all = (): Occurrence[] => [...rows];

	const forRoutine = (routineId: string): Occurrence[] => rows.filter((row) => row.routineId === routineId);

	/** Materializes at `due`, or answers the row already there. A tombstone outranks the rule. */
	const open = (routineId: string, scheduledAt: number, deadlineAt: number): Occurrence | null => {
		const held = at(routineId, scheduledAt);
		if (held) return held;
		const made: Occurrence = { routineId, scheduledAt, deadlineAt, state: "due", version: 1 };
		return commit([...rows, made]) ? made : null;
	};

	/**
	 * Moves an occurrence, or answers null. Refuses a move the table does not allow, and one whose
	 * version has changed, so two readers cannot both act on what they last saw.
	 */
	const transition = (
		routineId: string,
		scheduledAt: number,
		from: { state: OccurrenceState; version: number },
		to: OccurrenceState,
		patch: Partial<Pick<Occurrence, "reason" | "preparedRevision" | "snapshot" | "team">> = {},
	): Occurrence | null => {
		const held = at(routineId, scheduledAt);
		if (!held || held.state !== from.state || held.version !== from.version) return null;
		if (!canTransition(from.state, to)) return null;
		const moved: Occurrence = { ...held, ...patch, state: to, version: held.version + 1 };
		const next = rows.map((row) => (row === held ? moved : row));
		return commit(next) ? moved : null;
	};

	/**
	 * A re-save supersedes an occurrence waiting on review, and nothing else. A miss the owner has
	 * not dealt with is still theirs to answer, and what already ran still happened.
	 */
	const clearReview = (routineId: string): boolean => {
		const kept = rows.filter((row) => !(row.routineId === routineId && row.state === "needs_review"));
		if (kept.length === rows.length) return true;
		return commit(kept);
	};

	/** Everything for a routine goes when the routine does. */
	const clear = (routineId: string): boolean => {
		const kept = rows.filter((row) => row.routineId !== routineId);
		if (kept.length === rows.length) return true;
		return commit(kept);
	};

	/**
	 * Drops what nobody will look at again. A routine's newest miss is its panel and stays however
	 * old it is; anything else settled before the cutoff goes, or the file grows without end.
	 */
	const sweep = (before: number): number => {
		const newestMiss = new Map<string, number>();
		for (const row of rows) {
			if (row.state !== "missed") continue;
			const held = newestMiss.get(row.routineId);
			if (held === undefined || row.scheduledAt > held) newestMiss.set(row.routineId, row.scheduledAt);
		}
		const kept = rows.filter(
			(row) => row.scheduledAt >= before || newestMiss.get(row.routineId) === row.scheduledAt,
		);
		const dropped = rows.length - kept.length;
		if (dropped > 0) commit(kept);
		return dropped;
	};

	return { all, at, forRoutine, open, transition, clearReview, clear, sweep };
}

export type OccurrenceStore = ReturnType<typeof createOccurrenceStore>;
