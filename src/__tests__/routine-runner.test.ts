import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeRoutines } from "../gateway/compose/composeRoutines.js";
import { createOccurrenceStore } from "../gateway/routines/occurrences.js";
import { createRoutineRunner, GRACE_MS, type RoutineAttempt } from "../gateway/routines/runner.js";
import { createRoutineStore } from "../gateway/routines/store.js";
import type { Ambient } from "../shared/ambient.js";
import { openDurable } from "../shared/durable-store.js";
import type { Routine } from "../shared/schemasRoutine.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const MONDAY_0900_LA = Date.parse("2026-09-07T16:00:00Z");

const routine = (over: Partial<Routine> = {}): Routine => ({
	id: "triage",
	name: "Morning triage",
	weekdays: [1],
	weekInterval: 1,
	startDate: "2026-09-07",
	time: "09:00",
	zone: "America/Los_Angeles",
	runbookId: "book",
	approvedRevision: 3,
	values: {},
	target: { spawn: "host" },
	linkedEntries: [],
	enabled: true,
	revision: 1,
	// Taken long enough ago that recovery may reconstruct across a downtime.
	since: MONDAY_0900_LA - 365 * 24 * 60 * 60 * 1000,
	...over,
});

const A_YEAR_BEFORE = MONDAY_0900_LA - 365 * 24 * 60 * 60 * 1000;

const ready = { ok: true, revision: 3, snapshot: "do the thing", team: "host.routine-triage" } as const;
const moved = { ok: false, reason: "revision_moved" } as const;

function world(over: Partial<RoutineAttempt> = {}, took = A_YEAR_BEFORE) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-runner-"));
	roots.push(root);
	// The gateway stamps when it took a routine, so a test says so by moving this clock.
	const routines = openDurable(root, "routines", (store) =>
		createRoutineStore({ store, now: () => took, onChanged: () => undefined }),
	);
	const occurrences = openDurable(root, "routine-occurrences", (store) => createOccurrenceStore({ store }));
	let now = MONDAY_0900_LA;
	const delivered: string[] = [];
	const attempt: RoutineAttempt = {
		sessionIdle: () => true,
		prepare: async () => ready,
		deliver: async (_routine, occurrence) => {
			delivered.push(`${occurrence.routineId}:${occurrence.scheduledAt}`);
		},
		...over,
	};
	const runner = createRoutineRunner({
		routines,
		occurrences,
		ambient: {
			now: () => now,
			// Nothing fires on its own; every wakeup in these tests is an explicit reconcile.
			setTimer: () => ({}) as ReturnType<Ambient["setTimer"]>,
			clearTimer: () => undefined,
		},
		attempt: () => attempt,
	});
	// Nothing is admitted until the stage is armed, which activation does in the real graph.
	runner.start();
	return {
		routines,
		occurrences,
		runner,
		delivered,
		at: (instant: number) => {
			now = instant;
		},
	};
}

describe("the routine runner", () => {
	it("carries a due occurrence to dispatched, and delivers after it is durable", async () => {
		const w = world();
		w.routines.put(routine());

		await w.runner.reconcile();

		const held = w.occurrences.at("triage", MONDAY_0900_LA);
		expect(held?.state).toBe("dispatched");
		expect(held?.preparedRevision).toBe(3);
		expect(w.delivered).toEqual([`triage:${MONDAY_0900_LA}`]);
	});

	it("does not run the same occurrence twice", async () => {
		const w = world();
		w.routines.put(routine());

		await w.runner.reconcile();
		await w.runner.reconcile();

		expect(w.delivered).toHaveLength(1);
	});

	it("waits rather than missing while the session is busy, and misses when the window closes", async () => {
		const w = world({ sessionIdle: () => false });
		w.routines.put(routine());

		await w.runner.reconcile();
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.state).toBe("waiting_idle");

		w.at(MONDAY_0900_LA + GRACE_MS + 1);
		await w.runner.reconcile();
		const held = w.occurrences.at("triage", MONDAY_0900_LA);
		expect(held?.state).toBe("missed");
		expect(held?.reason).toBe("session_busy");
		expect(w.delivered).toEqual([]);
	});

	it("waits on an unreachable host, and says that rather than blaming a busy session", async () => {
		const w = world({ prepare: async () => ({ ok: false, reason: "unreachable" }) });
		w.routines.put(routine());

		await w.runner.reconcile();
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.state).toBe("waiting_idle");

		w.at(MONDAY_0900_LA + GRACE_MS + 1);
		await w.runner.reconcile();
		const held = w.occurrences.at("triage", MONDAY_0900_LA);
		expect(held?.state).toBe("missed");
		expect(held?.reason).toBe("host_unreachable");
		expect(w.delivered).toEqual([]);
	});

	it("sends a routine whose pinned revision moved for review, rather than firing it", async () => {
		const w = world({ prepare: async () => moved });
		w.routines.put(routine());

		await w.runner.reconcile();
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.state).toBe("needs_review");
		expect(w.delivered).toEqual([]);
	});

	it("does not dispatch after the routine is disabled during preparation", async () => {
		let release!: () => void;
		let started!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const preparationRelease = new Promise<void>((resolve) => {
			release = resolve;
		});
		const w = world({
			prepare: async () => {
				started();
				await preparationRelease;
				return ready;
			},
		});
		w.routines.put(routine());

		const reconcile = w.runner.reconcile();
		await preparationStarted;
		w.routines.setEnabled("triage", false);
		release();
		await reconcile;

		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.state).toBe("missed");
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.reason).toBe("disabled");
		expect(w.delivered).toEqual([]);
	});

	it("runs the words the owner now means when an edit lands mid-preparation", async () => {
		let release!: () => void;
		let started!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const preparationRelease = new Promise<void>((resolve) => {
			release = resolve;
		});
		let prepares = 0;
		const w = world({
			prepare: async (current) => {
				prepares += 1;
				if (prepares === 1) {
					started();
					await preparationRelease;
				}
				return { ...ready, snapshot: current.values.branch ?? "" };
			},
		});
		w.routines.put(routine({ values: { branch: "main" } }));

		const reconcile = w.runner.reconcile();
		await preparationStarted;
		expect(w.routines.put(routine({ values: { branch: "release" } }), { base: 1 })).toMatchObject({
			stored: true,
			revision: 2,
		});
		release();
		await reconcile;

		// The stale snapshot was dropped rather than dispatched, and the occurrence prepared again.
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.snapshot).toBe("release");
		expect(w.delivered).toEqual([`triage:${MONDAY_0900_LA}`]);
	});

	it("does not dispatch after preparation crosses the deadline", async () => {
		let release!: () => void;
		let started!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const preparationRelease = new Promise<void>((resolve) => {
			release = resolve;
		});
		const w = world({
			prepare: async () => {
				started();
				await preparationRelease;
				return ready;
			},
		});
		w.routines.put(routine());

		const reconcile = w.runner.reconcile();
		await preparationStarted;
		w.at(MONDAY_0900_LA + GRACE_MS + 1);
		release();
		await reconcile;

		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.state).toBe("missed");
		expect(w.delivered).toEqual([]);
	});

	it("holds the work open from dispatch until the session has worked and gone quiet again", async () => {
		let working = false;
		const w = world({ sessionIdle: () => !working });
		w.routines.put(routine());
		await w.runner.reconcile();

		const team = "host.routine-triage";
		// Dispatched and not yet picked up. An idle read here says nothing, so the work stays open.
		expect(w.runner.workingOccurrence(team)?.routineId).toBe("triage");
		await w.runner.reconcile();
		expect(w.runner.workingOccurrence(team)?.routineId).toBe("triage");

		working = true;
		await w.runner.reconcile();
		expect(w.runner.workingOccurrence(team)?.routineId).toBe("triage");

		working = false;
		await w.runner.reconcile();
		expect(w.runner.workingOccurrence(team)).toBeNull();
	});

	it("closes the work twelve hours after it began, whatever the session was ever seen doing", async () => {
		const w = world();
		w.routines.put(routine());
		await w.runner.reconcile();
		expect(w.runner.workingOccurrence("host.routine-triage")?.routineId).toBe("triage");

		w.at(MONDAY_0900_LA + GRACE_MS + 1);
		expect(w.runner.workingOccurrence("host.routine-triage")).toBeNull();
	});

	it("clears a review occurrence when the routine is saved again", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-stage-"));
		roots.push(root);
		let prepared = false;
		// Taken the minute before its slot.
		let now = MONDAY_0900_LA - 60_000;
		const delivered: string[] = [];
		const stage = composeRoutines({
			dataDir: root,
			ambient: {
				now: () => now,
				setTimer: () => ({}) as ReturnType<Ambient["setTimer"]>,
				clearTimer: () => undefined,
			},
			resolveCaller: () => null,
			attempt: () => ({
				sessionIdle: () => true,
				prepare: async () => (prepared ? ready : moved),
				deliver: async (_routine, occurrence) => {
					delivered.push(String(occurrence.scheduledAt));
				},
			}),
		});
		stage.console.put(routine());
		now = MONDAY_0900_LA;
		stage.start();
		await stage.reconcile();
		prepared = true;
		stage.console.put(routine());
		await stage.reconcile();

		expect(delivered).toEqual([String(MONDAY_0900_LA)]);
	});

	it("misses a disabled routine's open occurrence rather than running it", async () => {
		const w = world({ sessionIdle: () => false });
		w.routines.put(routine());
		await w.runner.reconcile();

		w.routines.setEnabled("triage", false);
		await w.runner.reconcile();
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.reason).toBe("disabled");
	});

	it("lets the owner run a missed occurrence again, and dismiss one", async () => {
		const w = world({ sessionIdle: () => false });
		w.routines.put(routine());
		await w.runner.reconcile();
		w.at(MONDAY_0900_LA + GRACE_MS + 1);
		await w.runner.reconcile();
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.state).toBe("missed");

		expect(await w.runner.runNow("triage", MONDAY_0900_LA)).toBe(true);
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.state).toBe("dispatched");
		expect(w.delivered).toHaveLength(1);
		// A run the owner asked for reaches the routine's own authority, as the ordinary road does.
		expect(w.runner.workingOccurrence("host.routine-triage")?.routineId).toBe("triage");

		// Already run, so there is nothing left to dismiss.
		expect(w.runner.dismiss("triage", MONDAY_0900_LA)).toBe(false);
	});

	it("gives a routine saved just now no miss for a slot before it existed", async () => {
		const w = world({}, MONDAY_0900_LA - 60_000);
		// Taken moments ago, with a start date well behind it.
		w.routines.put(routine({ startDate: "2026-01-05" }));

		await w.runner.reconcile();

		expect(w.occurrences.forRoutine("triage").filter((row) => row.state === "missed")).toEqual([]);
	});

	it("does not fire a routine saved this afternoon for a slot that passed this morning", async () => {
		// Taken an hour after today's slot, still inside its window.
		const w = world({}, MONDAY_0900_LA + 60 * 60 * 1000);
		w.at(MONDAY_0900_LA + 60 * 60 * 1000);
		w.routines.put(routine());

		await w.runner.reconcile();

		expect(w.occurrences.forRoutine("triage")).toEqual([]);
		expect(w.delivered).toEqual([]);
	});

	it("collapses weeks of unseen occurrences into one miss, and still runs the current one", async () => {
		const w = world();
		w.routines.put(routine());
		// Down for three weeks, back on a later Monday at the same local time.
		const back = MONDAY_0900_LA + 21 * 24 * 60 * 60 * 1000;
		w.at(back);

		await w.runner.reconcile();

		const rows = w.occurrences.forRoutine("triage");
		const missed = rows.filter((row) => row.state === "missed");
		// One panel for everything gone, not one per Monday.
		expect(missed).toHaveLength(1);
		expect(missed[0]?.reason).toBe("gateway_down");
		expect(missed[0]?.scheduledAt).toBe(back - 7 * 24 * 60 * 60 * 1000);
		// The one still inside its window runs as normal.
		expect(w.delivered).toEqual([`triage:${back}`]);
	});

	it("runs a fresh occurrence at the moment it was pressed, beside the rule's own", async () => {
		const w = world();
		w.routines.put(routine());
		await w.runner.reconcile();
		w.at(MONDAY_0900_LA + 60 * 60 * 1000);

		const opened = await w.runner.runFresh("triage");

		expect(opened).toBe(MONDAY_0900_LA + 60 * 60 * 1000);
		// Its own row, not a second walk of the slot the rule named.
		expect(w.occurrences.at("triage", opened as number)?.state).toBe("dispatched");
		expect(w.occurrences.at("triage", MONDAY_0900_LA)?.state).toBe("dispatched");
		expect(w.delivered).toEqual([`triage:${MONDAY_0900_LA}`, `triage:${opened}`]);
	});

	it("runs a disabled routine when the owner presses it, since disable stops the schedule", async () => {
		const w = world();
		w.routines.put(routine({ enabled: false }));

		const opened = await w.runner.runFresh("triage");

		expect(w.occurrences.at("triage", opened as number)?.state).toBe("dispatched");
		expect(w.delivered).toEqual([`triage:${opened}`]);
		// It reaches the routine's own authority, as a scheduled run does.
		expect(w.runner.workingOccurrence("host.routine-triage")?.routineId).toBe("triage");
	});

	it("refuses a press that lands on a slot the rule already named", async () => {
		const w = world();
		w.routines.put(routine());
		await w.runner.reconcile();

		// The rule's own row for next week, still waiting to be walked, and the press lands on its
		// exact instant.
		const slot = MONDAY_0900_LA + 7 * 24 * 60 * 60 * 1000;
		w.occurrences.open("triage", slot, slot + GRACE_MS);
		w.at(slot);

		expect(await w.runner.runFresh("triage")).toBe(null);

		// Untouched: walking it here would run a rule-named slot through the road that skips the
		// gates a scheduled run keeps.
		expect(w.occurrences.at("triage", slot)?.state).toBe("due");
		expect(w.delivered).toEqual([`triage:${MONDAY_0900_LA}`]);
	});

	it("keeps every check but enablement, so a pressed run still waits on a busy session", async () => {
		const w = world({ sessionIdle: () => false });
		w.routines.put(routine({ enabled: false }));

		const opened = await w.runner.runFresh("triage");

		expect(w.occurrences.at("triage", opened as number)?.state).toBe("waiting_idle");
		expect(w.delivered).toEqual([]);
	});

	it("says a pressed run did not happen when its words moved before it could be sent", async () => {
		const w = world({ prepare: async () => moved });
		w.routines.put(routine());

		// Refused for review, so nothing was delivered and the answer must not say otherwise.
		expect(await w.runner.runFresh("triage")).toBe(null);
		expect(w.delivered).toEqual([]);
	});

	it("names every window open in a session, not just the first", async () => {
		const w = world();
		w.routines.put(routine());
		await w.runner.reconcile();
		// Pressed twice while the scheduled run is still working, which nothing refuses.
		w.at(MONDAY_0900_LA + 1000);
		const first = await w.runner.runFresh("triage");
		w.at(MONDAY_0900_LA + 2000);
		const second = await w.runner.runFresh("triage");

		const open = w.runner.workingOccurrences("host.routine-triage").map((row) => row.scheduledAt);

		// A reader answering one leaves the rest alive, so a session that ended would keep the
		// routine's authority through whichever window it did not close.
		expect(open).toEqual([MONDAY_0900_LA, first, second]);
	});

	it("does not let a pressed run hide a scheduled slot that never happened", async () => {
		const w = world();
		w.routines.put(routine());
		// Today's slot runs, so it is the newest the rule named.
		await w.runner.reconcile();

		// Three weeks down. The owner presses Run before anything else reconciles, so the newest
		// occurrence by instant is one no rule named.
		const back = MONDAY_0900_LA + 21 * 24 * 60 * 60 * 1000;
		w.at(back + 60 * 60 * 1000);
		await w.runner.runFresh("triage");
		await w.runner.reconcile();

		const missed = w.occurrences.forRoutine("triage").filter((row) => row.state === "missed");
		expect(missed).toHaveLength(1);
		expect(missed[0]?.scheduledAt).toBe(back - 7 * 24 * 60 * 60 * 1000);
	});
});
