import { describe, expect, it } from "vitest";
import { createSingleFlight } from "../shared/single-flight.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("createSingleFlight", () => {
	it("joins the open flight for a key", async () => {
		const flights = createSingleFlight<string, number>();
		const pending = deferred<number>();
		let runs = 0;
		const work = () => {
			runs += 1;
			return pending.promise;
		};

		const first = flights.run("a", work);
		const second = flights.run("a", work);
		expect(second).toBe(first);
		expect(runs).toBe(1);
		pending.resolve(7);
		await expect(second).resolves.toBe(7);
	});

	it("releases a rejected flight for retry", async () => {
		const flights = createSingleFlight<string, number>();
		let runs = 0;
		const failed = flights.run("a", async () => {
			runs += 1;
			throw new Error();
		});

		await expect(failed).rejects.toBeDefined();
		await expect(
			flights.run("a", async () => {
				runs += 1;
				return 2;
			}),
		).resolves.toBe(2);
		expect(runs).toBe(2);
	});

	it("releases a settled flight for the next call", async () => {
		const flights = createSingleFlight<string, number>();
		let runs = 0;
		const next = () => {
			runs += 1;
			return Promise.resolve(runs);
		};

		await expect(flights.run("a", next)).resolves.toBe(1);
		await expect(flights.run("a", next)).resolves.toBe(2);
		expect(runs).toBe(2);
	});
});
