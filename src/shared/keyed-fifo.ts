// FIFO ordering per key.

export interface KeyedFifo<K> {
	/** Returns this work's outcome. */
	run<T>(key: K, work: () => T | PromiseLike<T>): Promise<T>;
	/** Whether `key` has queued or running work. */
	has(key: K): boolean;
	/** Awaits the queued snapshot. */
	drain(): Promise<void>;
}

export interface Fifo {
	run<T>(work: () => T | PromiseLike<T>): Promise<T>;
	drain(): Promise<void>;
}

export function createKeyedFifo<K>(): KeyedFifo<K> {
	const tails = new Map<K, Promise<void>>();
	return {
		run<T>(key: K, work: () => T | PromiseLike<T>): Promise<T> {
			const ran = (tails.get(key) ?? Promise.resolve()).then(work);
			// Failure never blocks successors.
			const tail: Promise<void> = ran.then(release, release);
			function release(): void {
				if (tails.get(key) === tail) tails.delete(key);
			}
			tails.set(key, tail);
			return ran;
		},
		has: (key) => tails.has(key),
		async drain(): Promise<void> {
			await Promise.all([...tails.values()]);
		},
	};
}

export function createFifo(): Fifo {
	const lane = createKeyedFifo<null>();
	return {
		run: (work) => lane.run(null, work),
		drain: () => lane.drain(),
	};
}
