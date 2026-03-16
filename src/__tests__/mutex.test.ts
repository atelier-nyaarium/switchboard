import { describe, expect, it } from "vitest";
import { getMutex, Mutex } from "../shared/mutex.js";

describe("Mutex", () => {
	it("acquire() on unlocked mutex resolves immediately", async () => {
		const m = new Mutex();
		const release = await m.acquire("id-1");
		expect(m.locked).toBe(true);
		expect(m.holder).toBe("id-1");
		release();
	});

	it("release() sets locked=false when queue is empty", async () => {
		const m = new Mutex();
		const release = await m.acquire("id-1");
		release();
		expect(m.locked).toBe(false);
		expect(m.holder).toBe(null);
	});

	it("release() dequeues and runs next waiter", async () => {
		const m = new Mutex();
		const release1 = await m.acquire("id-1");

		const p2 = m.acquire("id-2");
		expect(m.queue.length).toBe(1);

		release1();

		expect(m.locked).toBe(true);
		expect(m.holder).toBe("id-2");

		const release2 = await p2;
		release2();
		expect(m.locked).toBe(false);
	});

	it("three concurrent acquires preserve FIFO order", async () => {
		const m = new Mutex();
		const order: string[] = [];

		const release1 = await m.acquire("id-1");
		order.push("id-1");

		const p2 = m.acquire("id-2");
		const p3 = m.acquire("id-3");

		release1();
		expect(m.holder).toBe("id-2");
		order.push("id-2");

		const release2 = await p2;
		release2();
		expect(m.holder).toBe("id-3");
		order.push("id-3");

		const release3 = await p3;
		release3();

		expect(order).toEqual(["id-1", "id-2", "id-3"]);
	});

	it("holder tracks correct callbackId through cycles", async () => {
		const m = new Mutex();
		const release1 = await m.acquire("aaa");
		expect(m.holder).toBe("aaa");
		release1();
		expect(m.holder).toBe(null);

		const release2 = await m.acquire("bbb");
		expect(m.holder).toBe("bbb");
		release2();
	});
});

describe("getMutex", () => {
	it("creates a new Mutex for unknown team", () => {
		const locks = new Map();
		const m = getMutex(locks, "team-a");
		expect(m).toBeInstanceOf(Mutex);
		expect(locks.has("team-a")).toBe(true);
	});

	it("returns existing Mutex for known team", () => {
		const locks = new Map();
		const m1 = getMutex(locks, "team-a");
		const m2 = getMutex(locks, "team-a");
		expect(m1).toBe(m2);
	});
});
