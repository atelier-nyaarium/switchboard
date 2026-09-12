import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutineMemoryStore } from "../gateway/routines/memory.js";
import { DurableStore } from "../shared/durable-store.js";
import { MAX_ROUTINE_MEMORY_BYTES } from "../shared/schemasRoutine.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function open() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-memory-"));
	roots.push(root);
	return { root, memory: createRoutineMemoryStore({ store: new DurableStore(root, "routine-memory") }) };
}

describe("what a routine remembers between runs", () => {
	it("starts empty at a version no write could have produced", () => {
		const { memory } = open();
		expect(memory.read("inc-1")).toEqual({ text: "", version: 0 });
	});

	it("carries a run's history forward and moves the version with it", () => {
		const { memory } = open();
		const first = memory.write("inc-1", "signing keys refreshed", 0, 100);
		expect(first).toEqual({ ok: true, row: expect.objectContaining({ version: 1 }) });
		expect(memory.read("inc-1")).toEqual({ text: "signing keys refreshed", version: 1 });

		expect(memory.write("inc-1", "and the cache was cleaned", 1, 200)).toMatchObject({ ok: true });
		expect(memory.read("inc-1")).toEqual({ text: "and the cache was cleaned", version: 2 });
	});

	it("refuses a write against a version that moved, and says what is held", () => {
		const { memory } = open();
		memory.write("inc-1", "someone else wrote this", 0, 100);

		const stale = memory.write("inc-1", "mine, based on nothing", 0, 200);
		expect(stale).toEqual({ ok: false, current: { text: "someone else wrote this", version: 1 } });
		expect(memory.read("inc-1").text).toBe("someone else wrote this");
	});

	it("takes an overwrite regardless of version, which is the bounced filing's road", () => {
		const { memory } = open();
		memory.write("inc-1", "theirs", 0, 100);
		expect(memory.overwrite("inc-1", "consolidated", 200)).toMatchObject({ version: 2 });
		expect(memory.read("inc-1")).toEqual({ text: "consolidated", version: 2 });
	});

	// A recreated routine id gets a new incarnation, which is the whole point of keying on one.
	it("keeps incarnations apart", () => {
		const { memory } = open();
		memory.write("inc-1", "the dead routine's history", 0, 100);
		expect(memory.read("inc-2")).toEqual({ text: "", version: 0 });
	});

	it("drops memory whose routine is gone", () => {
		const { memory } = open();
		memory.write("inc-1", "live", 0, 100);
		memory.write("inc-2", "orphan", 0, 100);

		expect(memory.sweepOrphans(new Set(["inc-1"]))).toBe(1);
		expect(memory.read("inc-1").text).toBe("live");
		expect(memory.read("inc-2")).toEqual({ text: "", version: 0 });
	});

	// Restore refuses what a write refuses. An oversized row on disk is a hand edit or a bug, and
	// starting that routine's memory empty beats serving something no write could have made.
	it("starts a routine's memory fresh when the stored row is over the bound", () => {
		const { root } = open();
		const oversized = [
			{ incarnation: "inc-1", text: "x".repeat(MAX_ROUTINE_MEMORY_BYTES + 1), version: 3, at: 1 },
			{ incarnation: "inc-2", text: "fine", version: 1, at: 1 },
		];
		fs.writeFileSync(path.join(root, "routine-memory.json"), JSON.stringify(oversized));

		const reopened = createRoutineMemoryStore({ store: new DurableStore(root, "routine-memory") });
		expect(reopened.read("inc-1")).toEqual({ text: "", version: 0 });
		expect(reopened.read("inc-2").text).toBe("fine");
	});
});
