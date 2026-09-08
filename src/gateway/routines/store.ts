// The gateway names every revision it stores, and takes a put only from the one it already held.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import { renderRunbook } from "../../shared/runbook-grammar.js";
import { type Routine, RoutineSchema, routineRefusal } from "../../shared/schemasRoutine.js";
import { REVISION_CEILING, type Runbook } from "../../shared/schemasRunbook.js";

export interface RoutineStoreDeps {
	/** Opened through `openDurable`, so a poisoned file starts this store fresh. */
	store: DurableStore;
	/** The record cannot check itself against a runbook it cannot see. */
	getRunbook?: (runbookId: string) => Runbook | null;
	/** Whether this gateway has that spawn point. */
	knowsSpawn?: (spawn: string) => boolean;
}

export interface RoutinePutResult {
	stored: boolean;
	revision: number;
	/** What is now stored, so the caller adopts the revision rather than guessing it. */
	routine?: Routine;
	reason?: string;
}

export interface RoutinePutOptions {
	/** The revision the caller was editing. Absent means it believed there was nothing stored. */
	base?: number;
}

const RoutinesSchema = z.array(RoutineSchema);

/** A frozen copy, so neither a reader nor the caller that pushed it can edit what the store holds. */
function frozen(routine: Routine): Routine {
	return Object.freeze({
		...routine,
		weekdays: Object.freeze([...routine.weekdays].sort((a, b) => a - b)) as number[],
		values: Object.freeze({ ...routine.values }),
		target: Object.freeze({ ...routine.target }),
	});
}

/** Two records the owner would call the same. The revision is the gateway's, so it is not compared. */
function sameContent(a: Routine, b: Routine): boolean {
	return (
		a.name === b.name &&
		a.runbookId === b.runbookId &&
		a.approvedRevision === b.approvedRevision &&
		a.weekInterval === b.weekInterval &&
		a.startDate === b.startDate &&
		a.time === b.time &&
		a.zone === b.zone &&
		a.enabled === b.enabled &&
		a.target.spawn === b.target.spawn &&
		a.target.workdir === b.target.workdir &&
		a.weekdays.length === b.weekdays.length &&
		a.weekdays.every((day, i) => day === b.weekdays[i]) &&
		Object.keys(a.values).length === Object.keys(b.values).length &&
		Object.entries(a.values).every(([key, value]) => b.values[key] === value)
	);
}

/**
 * What the record cannot refuse for itself, because both need what only the gateway holds. Values
 * are complete at save so nothing is asked at fire time, and a target names a spawn that exists.
 */
function contextRefusal(routine: Routine, deps: RoutineStoreDeps): string | null {
	if (deps.knowsSpawn && !deps.knowsSpawn(routine.target.spawn)) {
		return `this Gateway has no spawn point called ${routine.target.spawn}`;
	}
	if (!deps.getRunbook) return null;
	const runbook = deps.getRunbook(routine.runbookId);
	if (!runbook) return `no runbook called ${routine.runbookId} is stored here`;
	if (runbook.revision !== routine.approvedRevision) {
		return `revision ${runbook.revision} is stored; this routine approved ${routine.approvedRevision}`;
	}
	const rendered = renderRunbook(runbook.body, runbook.parameters, routine.values);
	return rendered.ok ? null : rendered.reason;
}

export function createRoutineStore(deps: RoutineStoreDeps) {
	const { store } = deps;
	let routines: Routine[] = RoutinesSchema.parse(store.load() ?? []).map(frozen);

	/** A write the phone is told landed is on disk first. */
	const commit = (next: Routine[]): boolean => {
		const previous = routines;
		routines = next;
		try {
			store.saveChecked(routines);
			return true;
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) return true;
			routines = previous;
			console.warn(`[routine] write failed: ${(error as Error).message}`);
			return false;
		}
	};

	const held = (id: string): Routine | undefined => routines.find((routine) => routine.id === id);

	const list = (): Routine[] =>
		[...routines].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

	const get = (id: string): Routine | null => held(id) ?? null;

	const put = (incoming: Routine, options: RoutinePutOptions = {}): RoutinePutResult => {
		const current = held(incoming.id);
		const held0 = current?.revision ?? 0;
		const refusal = routineRefusal(incoming) ?? contextRefusal(incoming, deps);
		if (refusal) return { stored: false, revision: held0, reason: refusal };
		const candidate = frozen(incoming);
		if (current) {
			// A repeat of what is stored is a lost answer, whichever stage it was lost at.
			const echoesFirst = options.base === undefined && current.revision === 1;
			const echoesEdit = options.base === current.revision || options.base === current.revision - 1;
			if ((echoesFirst || echoesEdit) && sameContent(candidate, current)) {
				return { stored: true, revision: current.revision, routine: current };
			}
			if (options.base !== current.revision) {
				return {
					stored: false,
					revision: current.revision,
					reason: `revision ${current.revision} is stored; this edits ${options.base ?? "nothing"}`,
				};
			}
		}
		if (!current && options.base !== undefined) {
			return { stored: false, revision: 0, reason: "no routine with that id is stored" };
		}
		if (held0 >= REVISION_CEILING) {
			return { stored: false, revision: held0, reason: "this routine has no revision left to write" };
		}
		const routine = frozen({ ...candidate, revision: held0 + 1 });
		const next = current
			? routines.map((existing) => (existing.id === routine.id ? routine : existing))
			: [...routines, routine];
		if (!commit(next)) return { stored: false, revision: held0, reason: "could not be written" };
		return { stored: true, revision: routine.revision, routine };
	};

	/** Enabling is a whole-record write, so it moves the revision as any other edit does. */
	const setEnabled = (id: string, enabled: boolean): RoutinePutResult => {
		const current = held(id);
		if (!current) return { stored: false, revision: 0, reason: "no routine with that id is stored" };
		if (current.enabled === enabled) return { stored: true, revision: current.revision, routine: current };
		return put({ ...current, enabled }, { base: current.revision });
	};

	const remove = (id: string): { deleted: boolean } => {
		const kept = routines.filter((routine) => routine.id !== id);
		if (kept.length === routines.length) return { deleted: false };
		return { deleted: commit(kept) };
	};

	return { list, get, put, setEnabled, remove };
}

export type RoutineStore = ReturnType<typeof createRoutineStore>;
