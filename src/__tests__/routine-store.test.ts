import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoutineStore } from "../gateway/routines/store.js";
import { openDurable } from "../shared/durable-store.js";
import type { Routine } from "../shared/schemasRoutine.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-store-"));
	roots.push(root);
	return root;
};
const open = (dataDir: string) =>
	openDurable(dataDir, "routines", (store) => createRoutineStore({ store, now: () => 1_700_000_000_000 }));

const routine = (id: string, over: Partial<Routine> = {}): Routine => ({
	id,
	name: id,
	weekdays: [1],
	weekInterval: 1,
	startDate: "2026-09-07",
	time: "09:00",
	zone: "America/Los_Angeles",
	runbookId: "triage",
	approvedRevision: 1,
	values: {},
	target: { spawn: "host" },
	linkedEntries: [],
	enabled: true,
	revision: 1,
	since: 0,
	...over,
});

describe("routine store", () => {
	it("holds what the phone pushed and gives it back across a reopen", () => {
		const dataDir = fresh();
		expect(open(dataDir).put(routine("morning"))).toMatchObject({ stored: true, revision: 1 });
		expect(
			open(dataDir)
				.list()
				.map((r) => r.id),
		).toEqual(["morning"]);
	});

	it("names the revision itself, and takes a put only from the one it holds", () => {
		const store = open(fresh());
		expect(store.put(routine("morning", { revision: 44 }))).toMatchObject({ stored: true, revision: 1 });

		expect(store.put(routine("morning", { name: "Two" }), { base: 1 })).toMatchObject({
			stored: true,
			revision: 2,
		});
		expect(store.put(routine("morning", { name: "Other" }), { base: 1 })).toMatchObject({
			stored: false,
			revision: 2,
		});
		expect(store.get("morning")?.name).toBe("Two");
	});

	it("takes a repeat of what it holds as a lost answer, and any real edit as an edit", () => {
		const store = open(fresh());
		store.put(routine("morning"));
		expect(store.put(routine("morning"))).toMatchObject({ stored: true, revision: 1 });
		expect(store.list()).toHaveLength(1);

		// Every field the owner writes is compared, including any added since this was written.
		const edits: Array<Partial<Routine>> = [
			{ name: "Other" },
			{ linkedEntries: ["deploy"] },
			{ target: { spawn: "host", workdir: "/tmp" } },
			{ values: { branch: "main" } },
		];
		let revision = 1;
		for (const edit of edits) {
			const answer = store.put(routine("morning", { ...edit }), { base: revision });
			expect(answer, JSON.stringify(edit)).toMatchObject({ stored: true, revision: revision + 1 });
			revision += 1;
		}
	});

	it("refuses a schedule that could never come around, leaving the held one alone", () => {
		const store = open(fresh());
		store.put(routine("morning"));
		const refused = store.put(routine("morning", { weekdays: [] }), { base: 1 });
		expect(refused.stored).toBe(false);
		expect(refused.reason).toBeTruthy();
		expect(store.get("morning")?.revision).toBe(1);
	});

	it("moves the revision when enabling, and answers the held one when nothing changes", () => {
		const store = open(fresh());
		store.put(routine("morning"));
		expect(store.setEnabled("morning", false)).toMatchObject({ stored: true, revision: 2 });
		expect(store.get("morning")?.enabled).toBe(false);
		// Already off, so there is nothing to write and no revision to spend.
		expect(store.setEnabled("morning", false)).toMatchObject({ stored: true, revision: 2 });
		expect(store.setEnabled("ghost", true).stored).toBe(false);
	});

	it("orders by name, then by id, and deletes once", () => {
		const store = open(fresh());
		store.put(routine("b", { name: "Zebra" }));
		store.put(routine("a", { name: "Apple" }));
		expect(store.list().map((r) => r.id)).toEqual(["a", "b"]);
		expect(store.remove("a")).toEqual({ deleted: true });
		expect(store.remove("a")).toEqual({ deleted: false });
	});

	it("refuses a routine whose reserved session name something else already holds", () => {
		const guarded = openDurable(fresh(), "routines", (store) =>
			createRoutineStore({ store, now: () => 1_700_000_000_000, sessionTaken: () => true }),
		);
		const refused = guarded.put(routine("morning"));
		expect(refused.stored).toBe(false);
		expect(refused.reason).toContain("host.routine-morning");
	});

	it("refuses to hand a caller the record it holds to edit", () => {
		const store = open(fresh());
		store.put(routine("morning"));
		const listed = store.list()[0] as Routine;
		expect(() => {
			(listed as { name: string }).name = "tampered";
		}).toThrow();
	});
});
