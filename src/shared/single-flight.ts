export function createSingleFlight<K, T>() {
	const flights = new Map<K, Promise<T>>();

	const run = (key: K, work: () => Promise<T>): Promise<T> => {
		const existing = flights.get(key);
		if (existing) return existing;

		let resolveFlight!: (value: T | PromiseLike<T>) => void;
		let rejectFlight!: (reason?: unknown) => void;
		const flight = new Promise<T>((resolve, reject) => {
			resolveFlight = resolve;
			rejectFlight = reject;
		});
		flights.set(key, flight);

		const release = (): void => {
			if (flights.get(key) === flight) flights.delete(key);
		};
		try {
			Promise.resolve(work()).then(
				(value) => {
					release();
					resolveFlight(value);
				},
				(error: unknown) => {
					release();
					rejectFlight(error);
				},
			);
		} catch (error) {
			release();
			rejectFlight(error);
		}
		return flight;
	};

	return {
		run,
		has: (key: K): boolean => flights.has(key),
		get open(): number {
			return flights.size;
		},
	};
}
