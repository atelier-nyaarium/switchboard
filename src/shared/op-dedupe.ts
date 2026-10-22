import { createSingleFlight } from "./single-flight.js";

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
	const inFlight = createSingleFlight<string, T>();

	const sweep = (): void => {
		const cutoff = deps.now() - deps.holdMs;
		for (const [key, entry] of [...settled]) {
			if (entry.at <= cutoff) settled.delete(key);
		}
	};

	/** Runs `work` at most once per key, joining a flight already open and replaying a settled answer. */
	const once = (key: string, work: () => Promise<T>): Promise<T> => {
		sweep();
		const already = settled.get(key);
		if (already !== undefined) return Promise.resolve(already.result);

		return inFlight.run(key, async () => {
			const result = await work();
			settled.set(key, { at: deps.now(), result });
			return result;
		});
	};

	return {
		once,
		get held(): number {
			return settled.size;
		},
		get open(): number {
			return inFlight.open;
		},
	};
}

export type OpDedupe<T> = ReturnType<typeof createOpDedupe<T>>;
