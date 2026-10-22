// At-most-once by caller key.
// In-flight replays join; settled replays reuse the answer.

interface Settled<T> {
	at: number;
	result: T;
}

export interface DedupeDeps {
	now: () => number;
	/** How long a settled key answers from memory. */
	holdMs: number;
}

export function createOpDedupe<T>(deps: DedupeDeps) {
	const settled = new Map<string, Settled<T>>();
	const inFlight = new Map<string, Promise<T>>();

	const sweep = (): void => {
		const cutoff = deps.now() - deps.holdMs;
		for (const [key, entry] of [...settled]) {
			if (entry.at <= cutoff) settled.delete(key);
		}
	};

	/** Runs `work` at most once per key, joining a flight already open and replaying a settled answer. */
	const once = async (key: string, work: () => Promise<T>): Promise<T> => {
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

export type OpDedupe<T> = ReturnType<typeof createOpDedupe<T>>;
