import { describe, expect, it } from "vitest";
import { createFifo, createKeyedFifo } from "../shared/keyed-fifo.js";

function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

describe("keyed FIFO", () => {
	it("runs one key in arrival order while other keys overlap it", async () => {
		const fifo = createKeyedFifo<string>();
		const held = gate();
		const log: string[] = [];

		const first = fifo.run("a", async () => {
			await held.opened;
			log.push("a1");
		});
		const second = fifo.run("a", () => log.push("a2"));
		await fifo.run("b", () => log.push("b1"));
		expect(log).toEqual(["b1"]);

		held.open();
		await Promise.all([first, second]);
		expect(log).toEqual(["b1", "a1", "a2"]);
	});

	it("answers each caller its own failure and still runs the next item", async () => {
		const fifo = createFifo();
		const failed = fifo.run(() => {
			throw new Error("boom");
		});
		const next = fifo.run(async () => "ran");

		await expect(failed).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ran");
	});

	it("drains only what was queued when asked", async () => {
		const fifo = createKeyedFifo<string>();
		const early = gate();
		const late = gate();
		const done: string[] = [];
		void fifo.run("a", async () => {
			await early.opened;
			done.push("early");
		});

		const drained = fifo.drain();
		void fifo.run("a", async () => {
			await late.opened;
			done.push("late");
		});
		early.open();
		await drained;

		expect(done).toEqual(["early"]);
		expect(fifo.has("a")).toBe(true);
		late.open();
		await fifo.drain();
		expect(done).toEqual(["early", "late"]);
		expect(fifo.has("a")).toBe(false);
	});
});
