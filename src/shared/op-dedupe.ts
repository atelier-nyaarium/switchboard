import { createSingleFlight } from "./single-flight.js";

// Keys join in-flight work or reuse retained answers. Expiry and count eviction permit reruns.

interface Settled<T> {
	at: number;
	result: T;
}

export interface DedupeDeps {
	now: () => number;
	/** How long a settled key answers from memory. */
	holdMs?: number;
	/** Maximum number of settled answers retained. */
	maxEntries?: number;
}

export function createOpDedupe<T>(deps: DedupeDeps) {
	const settled = new Map<string, Settled<T>>();
	const inFlight = createSingleFlight<string, T>();

	const sweep = (): void => {
		if (deps.holdMs !== undefined) {
			const cutoff = deps.now() - deps.holdMs;
			for (const [key, entry] of [...settled]) {
				if (entry.at <= cutoff) settled.delete(key);
			}
		}
	};

	/** Runs at most once while a key is in flight or its settled answer is retained. */
	const once = (key: string, work: () => Promise<T>, replay?: (result: T) => void): Promise<T> => {
		sweep();
		const already = settled.get(key);
		if (already !== undefined) {
			replay?.(already.result);
			return Promise.resolve(already.result);
		}

		return inFlight.run(key, async () => {
			const result = await work();
			settled.delete(key);
			settled.set(key, { at: deps.now(), result });
			while (deps.maxEntries !== undefined && settled.size > deps.maxEntries) {
				const oldest = settled.keys().next().value;
				if (oldest === undefined) break;
				settled.delete(oldest);
			}
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
