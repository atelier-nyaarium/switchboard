// At-most-once for the workspace plane, defined on the answering side.
//
// The plane is neither a transient value op nor the Router's delivery ledger, so nothing upstream
// dedupes for it. A replayed key answers the FIRST result rather than running the op again.
//
// An op still in flight is joined rather than re-run, or a replay arriving before the first answer
// would do the work twice and the dedupe would have bought nothing.

import type { WorkspaceOpResult } from "../../shared/workspace-op.js";

interface Settled {
	at: number;
	result: WorkspaceOpResult;
}

export interface DedupeDeps {
	now: () => number;
	/** How long a settled key answers from memory. */
	holdMs: number;
}

export function createOpDedupe(deps: DedupeDeps) {
	const settled = new Map<string, Settled>();
	const inFlight = new Map<string, Promise<WorkspaceOpResult>>();

	const sweep = (): void => {
		const cutoff = deps.now() - deps.holdMs;
		for (const [key, entry] of [...settled]) {
			if (entry.at <= cutoff) settled.delete(key);
		}
	};

	/** Runs `work` at most once per key, joining a flight already open and replaying a settled answer. */
	const once = async (key: string, work: () => Promise<WorkspaceOpResult>): Promise<WorkspaceOpResult> => {
		sweep();
		const already = settled.get(key);
		if (already !== undefined) return already.result;

		const open = inFlight.get(key);
		if (open !== undefined) return await open;

		const flight = work().then(
			(result) => {
				settled.set(key, { at: deps.now(), result });
				inFlight.delete(key);
				return result;
			},
			(error: unknown) => {
				// A thrown op is NOT settled: nothing was answered, so a retry must be allowed to run.
				inFlight.delete(key);
				throw error;
			},
		);
		inFlight.set(key, flight);
		return await flight;
	};

	return {
		once,
		get held(): number {
			return settled.size;
		},
		get open(): number {
			return inFlight.size;
		},
	};
}

export type OpDedupe = ReturnType<typeof createOpDedupe>;
