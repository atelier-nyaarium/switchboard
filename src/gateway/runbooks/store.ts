// The gateway names every revision it stores, and takes a put only from the one it already held.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import { REVISION_CEILING, type Runbook, RunbookSchema, runbookRefusal } from "../../shared/schemasRunbook.js";

export interface RunbookStoreDeps {
	/** Opened through `openDurable`, so a poisoned file starts this store fresh. */
	store: DurableStore;
}

export interface RunbookPutResult {
	stored: boolean;
	revision: number;
	/** What is now stored, so the caller adopts the revision rather than guessing it. */
	runbook?: Runbook;
	reason?: string;
}

export interface RunbookPutOptions {
	/** The revision the caller was editing. Absent means it believed there was nothing stored. */
	base?: number;
	/** Replaces what is held, whatever its revision. Only an owner tap sets it. */
	overwrite?: boolean;
}

const RunbooksSchema = z.array(RunbookSchema);

/** A frozen copy, so neither a reader nor the caller that pushed it can edit what the store holds. */
function frozen(runbook: Runbook): Runbook {
	const parameters = runbook.parameters.map((parameter) => {
		const copy = { ...parameter };
		// Options mean nothing to a text parameter, so one representation rather than two.
		if (copy.kind !== "choice") copy.options = undefined;
		if (copy.options) {
			copy.options = [...copy.options];
			Object.freeze(copy.options);
		}
		return Object.freeze(copy);
	});
	Object.freeze(parameters);
	return Object.freeze({ ...runbook, parameters });
}

/** Two records the owner would call the same. Compared field by field, never by key order. */
function sameContent(a: Runbook, b: Runbook): boolean {
	return (
		a.name === b.name &&
		a.body === b.body &&
		a.parameters.length === b.parameters.length &&
		a.parameters.every((parameter, i) => {
			const other = b.parameters[i] as (typeof b.parameters)[number];
			return (
				parameter.name === other.name &&
				parameter.label === other.label &&
				parameter.kind === other.kind &&
				parameter.default === other.default &&
				(parameter.options ?? []).length === (other.options ?? []).length &&
				(parameter.options ?? []).every((option, j) => option === (other.options ?? [])[j])
			);
		})
	);
}

export function createRunbookStore(deps: RunbookStoreDeps) {
	const { store } = deps;
	// Restore keeps whatever the schema accepts. `put` is the only writer, so the semantic rules ran
	// before anything landed, and discarding a record here would erase it on the next write.
	let runbooks: Runbook[] = RunbooksSchema.parse(store.load() ?? []).map(frozen);

	/**
	 * What a deleted id last held. Without it a delayed put from another phone lands as a first
	 * write and the runbook is back, since "nothing stored" reads the same either way. Not durable:
	 * a restart is long enough after a delete that an in-flight put is no longer in flight.
	 */
	const buried = new Map<string, number>();

	/** A write the phone is told landed is on disk first. */
	const commit = (next: Runbook[]): boolean => {
		const previous = runbooks;
		runbooks = next;
		try {
			store.saveChecked(runbooks);
			return true;
		} catch (error) {
			// An installed snapshot is what a reopen reads.
			if (error instanceof DurableStoreInstalledError) return true;
			runbooks = previous;
			console.warn(`[runbook] write failed: ${(error as Error).message}`);
			return false;
		}
	};

	const held = (id: string): Runbook | undefined => runbooks.find((runbook) => runbook.id === id);

	/** A shared name still gives one order. */
	const list = (): Runbook[] =>
		[...runbooks].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

	const get = (id: string): Runbook | null => held(id) ?? null;

	const put = (incoming: Runbook, options: RunbookPutOptions = {}): RunbookPutResult => {
		const current = held(incoming.id);
		const held0 = current?.revision ?? 0;
		const refusal = runbookRefusal(incoming);
		if (refusal) return { stored: false, revision: held0, reason: refusal };
		// Canonical before comparing, or a repeat that spells a dropped field differently reads as an
		// edit, and the caller is refused for content the store already holds.
		const candidate = frozen(incoming);
		if (current && !options.overwrite) {
			// A repeat of what is stored is a lost answer, whichever stage it was lost at: before the
			// write, after it, or after a first write the caller still believes it has not made.
			const echoesFirst = options.base === undefined && current.revision === 1;
			const echoesEdit = options.base === current.revision || options.base === current.revision - 1;
			if ((echoesFirst || echoesEdit) && sameContent(candidate, current)) {
				return { stored: true, revision: current.revision, runbook: current };
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
			return { stored: false, revision: 0, reason: "no runbook with that id is stored" };
		}
		const grave = buried.get(incoming.id);
		if (!current && grave !== undefined && !options.overwrite) {
			return { stored: false, revision: 0, reason: `revision ${grave} was deleted; save it as a new runbook` };
		}
		if (held0 >= REVISION_CEILING) {
			return { stored: false, revision: held0, reason: "this runbook has no revision left to write" };
		}
		// The gateway names the revision, so nobody else can name one it would not have chosen.
		const runbook = frozen({ ...candidate, revision: held0 + 1 });
		const next = current
			? runbooks.map((existing) => (existing.id === runbook.id ? runbook : existing))
			: [...runbooks, runbook];
		if (!commit(next)) return { stored: false, revision: held0, reason: "could not be written" };
		return { stored: true, revision: runbook.revision, runbook };
	};

	const remove = (id: string): { deleted: boolean } => {
		const going = held(id);
		const kept = runbooks.filter((runbook) => runbook.id !== id);
		if (!going) return { deleted: false };
		const deleted = commit(kept);
		if (deleted) buried.set(id, going.revision);
		return { deleted };
	};

	return { list, get, put, remove };
}

export type RunbookStore = ReturnType<typeof createRunbookStore>;
