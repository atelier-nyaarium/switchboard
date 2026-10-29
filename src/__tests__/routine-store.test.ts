import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNPLACED_REASON } from "../gateway/routines/reservation.js";
import { createRoutineStore } from "../gateway/routines/store.js";
import { openDurable } from "../shared/durable-store.js";
import { type Routine, targetKind } from "../shared/schemasRoutine.js";

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
	openDurable(dataDir, "routines", (store) =>
		createRoutineStore({
			store,
			now: () => 1_700_000_000_000,
			newIncarnation: () => "inc-1",
			onChanged: () => undefined,
		}),
	);

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
	forgetAfterDays: 7,
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
		expect(store.setEnabled("morning", false, 1)).toMatchObject({ stored: true, revision: 2 });
		expect(store.get("morning")?.enabled).toBe(false);
		// Already off, so there is nothing to write and no revision to spend.
		expect(store.setEnabled("morning", false, 2)).toMatchObject({ stored: true, revision: 2 });
		// A toggle carries the revision the phone read, so a stale one is refused like a put.
		expect(store.setEnabled("morning", true, 1)).toMatchObject({ stored: false, revision: 2 });
		expect(store.setEnabled("morning", true, 2)).toMatchObject({ stored: true, revision: 3 });
		expect(store.setEnabled("ghost", true, 1).stored).toBe(false);
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
			createRoutineStore({
				store,
				now: () => 1_700_000_000_000,
				newIncarnation: () => "inc-1",
				sessionTaken: () => true,
				onChanged: () => undefined,
			}),
		);
		const refused = guarded.put(routine("morning"));
		expect(refused.stored).toBe(false);
		expect(refused.reason).toContain("host.routine-morning");
	});

	it("gives a routine stored before incarnations one at restore, and keeps it", () => {
		const dataDir = fresh();
		const { incarnation: _incarnation, ...legacy } = routine("legacy");
		fs.writeFileSync(path.join(dataDir, "routines.json"), JSON.stringify([legacy]));
		let minted = 0;
		const reopen = () =>
			openDurable(dataDir, "routines", (store) =>
				createRoutineStore({
					store,
					now: () => 1_700_000_000_000,
					newIncarnation: () => `inc-${++minted}`,
					onChanged: () => undefined,
				}),
			);

		expect(reopen().get("legacy")?.incarnation).toBe("inc-1");
		expect(reopen().get("legacy")?.incarnation).toBe("inc-1");
	});

	it("restores rows written before a target had a kind, and reads them as spawn routines", () => {
		const dataDir = fresh();
		open(dataDir).put(routine("legacy", { target: { spawn: "host", workdir: "/tmp" } }));
		const reopened = open(dataDir).get("legacy");
		expect(reopened?.target).toEqual({ spawn: "host", workdir: "/tmp" });
		expect(reopened && targetKind(reopened.target)).toBe("spawn");
	});

	it("takes a check-in only where the assistant lives, with no secrets, and never back from a phone that predates it", () => {
		let placed = false;
		const store = openDurable(fresh(), "routines", (durable) =>
			createRoutineStore({
				store: durable,
				now: () => 1_700_000_000_000,
				newIncarnation: () => "inc-1",
				assistantPlaced: () => placed,
				onChanged: () => undefined,
			}),
		);
		const checkIn = routine("standup", { target: { kind: "assistant", spawn: "host" } });

		expect(store.put(checkIn)).toMatchObject({
			stored: false,
			reason: UNPLACED_REASON,
		});
		placed = true;
		expect(store.put({ ...checkIn, linkedEntries: ["deploy"] })).toMatchObject({ stored: false });
		expect(store.put({ ...checkIn, target: { kind: "assistant", spawn: "box" } })).toMatchObject({ stored: false });
		expect(store.put(checkIn)).toMatchObject({ stored: true, revision: 1 });

		const olderPhone = store.put(routine("standup", { name: "Renamed" }), { base: 1 });
		expect(olderPhone.stored).toBe(false);
		expect(store.get("standup")?.target.kind).toBe("assistant");
		expect(store.put({ ...checkIn, name: "Renamed" }, { base: 1 })).toMatchObject({ stored: true, revision: 2 });

		// Released: it can be turned off but not edited.
		placed = false;
		expect(store.put({ ...checkIn, name: "Again" }, { base: 2 }).stored).toBe(false);
		expect(store.setEnabled("standup", false, 2)).toMatchObject({ stored: true, revision: 3 });
		expect(store.setEnabled("standup", true, 3).stored).toBe(false);
	});

	it("starts memory afresh when a routine changes target kind, and keeps it across any other edit", () => {
		let minted = 0;
		const store = openDurable(fresh(), "routines", (durable) =>
			createRoutineStore({
				store: durable,
				now: () => 1_700_000_000_000,
				newIncarnation: () => `inc-${++minted}`,
				assistantPlaced: () => true,
				onChanged: () => undefined,
			}),
		);
		store.put(routine("triage"));
		// A kindless row is a spawn routine, so naming the kind keeps its memory.
		store.put(routine("triage", { name: "Renamed", target: { kind: "spawn", spawn: "host", workdir: "/tmp" } }), {
			base: 1,
		});
		expect(store.get("triage")?.incarnation).toBe("inc-1");

		store.put(routine("triage", { target: { kind: "assistant", spawn: "host" } }), { base: 2 });
		expect(store.get("triage")?.incarnation).toBe("inc-2");
		store.put(routine("triage", { target: { kind: "spawn", spawn: "host" } }), { base: 3 });
		expect(store.get("triage")?.incarnation).toBe("inc-3");
	});

	it("keeps a landed write when the runner hook throws", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const dataDir = fresh();
		const hook = vi.fn(() => {
			throw new Error("runner gone");
		});
		const store = openDurable(dataDir, "routines", (durable) =>
			createRoutineStore({
				store: durable,
				now: () => 1_700_000_000_000,
				newIncarnation: () => "inc-1",
				onChanged: hook,
			}),
		);

		expect(store.put(routine("morning"))).toMatchObject({ stored: true, revision: 1 });
		expect(store.get("morning")).toMatchObject({ revision: 1 });
		expect(open(dataDir).get("morning")).toMatchObject({ revision: 1 });
		expect(hook).toHaveBeenCalledOnce();
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
