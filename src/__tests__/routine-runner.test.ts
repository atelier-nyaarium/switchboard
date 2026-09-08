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
	enabled: true,
	revision: 1,
	// Taken long enough ago that recovery may reconstruct across a downtime.
	since: MONDAY_0900_LA - 365 * 24 * 60 * 60 * 1000,
	...over,
});

const A_YEAR_BEFORE = MONDAY_0900_LA - 365 * 24 * 60 * 60 * 1000;

function world(over: Partial<RoutineAttempt> = {}, took = A_YEAR_BEFORE) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-runner-"));
	roots.push(root);
	// The gateway stamps when it took a routine, so a test says so by moving this clock.
	const routines = openDurable(root, "routines", (store) => createRoutineStore({ store, now: () => took }));
	const occurrences = openDurable(root, "routine-occurrences", (store) => createOccurrenceStore({ store }));
	let now = MONDAY_0900_LA;
	const delivered: string[] = [];
	const attempt: RoutineAttempt = {
		sessionIdle: () => true,
		prepare: async () => 3,
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
		attempt,
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

	it("sends a routine whose pinned revision moved for review, rather than firing it", async () => {
		const w = world({ prepare: async () => null });
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
				return 3;
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
				return 3;
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

	it("clears a review occurrence when the routine is saved again", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-stage-"));
		roots.push(root);
		let prepared: number | null = null;
		const delivered: string[] = [];
		const stage = composeRoutines({
			dataDir: root,
			ambient: {
				now: () => MONDAY_0900_LA,
				setTimer: () => ({}) as ReturnType<Ambient["setTimer"]>,
				clearTimer: () => undefined,
			},
			attempt: {
				sessionIdle: () => true,
				prepare: async () => prepared,
				deliver: async (_routine, occurrence) => {
					delivered.push(String(occurrence.scheduledAt));
				},
			},
		});
		stage.console.put(routine());
		stage.start();
		await stage.reconcile();
		prepared = 3;
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
});
