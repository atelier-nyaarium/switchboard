import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeRoutines } from "../gateway/compose/composeRoutines.js";
import type { Ambient } from "../shared/ambient.js";
import type { Routine } from "../shared/schemasRoutine.js";
import type { Runbook } from "../shared/schemasRunbook.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const routine = (over: Partial<Routine> = {}): Routine => ({
	id: "triage",
	name: "Morning triage",
	weekdays: [1],
	weekInterval: 1,
	startDate: "2026-09-07",
	time: "09:00",
	zone: "America/Los_Angeles",
	runbookId: "book",
	approvedRevision: 1,
	values: {},
	target: { spawn: "host" },
	linkedEntries: ["deploy"],
	enabled: true,
	revision: 1,
	since: 0,
	...over,
});

const MONDAY_0900_LA = Date.parse("2026-09-07T16:00:00Z");
const TEAM = "host.routine-triage";

function stage(over: Partial<Runbook> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-grants-"));
	roots.push(root);
	let runbook: Runbook | null = { id: "book", name: "Book", body: "do it", parameters: [], revision: 1, ...over };
	let now = MONDAY_0900_LA - 60_000;
	let ownsSession = true;
	const authorized: string[][] = [];
	const routines = composeRoutines({
		dataDir: root,
		ambient: {
			now: () => now,
			setTimer: () => ({}) as ReturnType<Ambient["setTimer"]>,
			clearTimer: () => undefined,
		},
		getRunbook: () => runbook,
		sessionOwned: () => ownsSession,
		setRoutineGrants: (_routineId, entryIds) => {
			authorized.push(entryIds);
		},
		attempt: () => ({
			sessionIdle: () => true,
			prepare: async () => ({ ok: true, revision: 1, snapshot: "do it", team: TEAM }),
			deliver: async () => undefined,
		}),
	});
	routines.start();
	return {
		routines,
		authorized,
		/** What the routine may reach after the last thing that touched it. */
		latest: () => authorized.at(-1),
		wanted: (routineId: string) =>
			routines.console.list().routines.find((row) => row.routine.id === routineId)?.attention,
		at: (instant: number) => {
			now = instant;
		},
		/** Something took the reserved session's name, so its record is no longer the routine's. */
		loseSession: () => {
			ownsSession = false;
		},
		moveRunbook: (to: Runbook | null) => {
			runbook = to;
			routines.runbookMoved("book");
		},
	};
}

describe("what a routine is authorized to reach", () => {
	it("takes what the save links, and nothing a refused save asked for", () => {
		const s = stage();
		expect(s.routines.console.put(routine()).stored).toBe(true);
		expect(s.latest()).toEqual(["deploy"]);

		// Refused for editing a revision the store does not hold, so authority does not move either.
		expect(s.routines.console.put(routine({ linkedEntries: ["deploy", "npm"] }), 9).stored).toBe(false);
		expect(s.latest()).toEqual(["deploy"]);

		expect(s.routines.console.put(routine({ linkedEntries: ["npm"] }), 1).stored).toBe(true);
		expect(s.latest()).toEqual(["npm"]);
	});

	it("holds nothing while disabled, and takes its links back when enabled again", () => {
		const s = stage();
		s.routines.console.put(routine());

		s.routines.console.enable("triage", false);
		expect(s.latest()).toEqual([]);

		s.routines.console.enable("triage", true);
		expect(s.latest()).toEqual(["deploy"]);
	});

	it("holds nothing once deleted", () => {
		const s = stage();
		s.routines.console.put(routine());

		expect(s.routines.console.remove("triage")).toEqual({ deleted: true });
		expect(s.latest()).toEqual([]);
	});

	it("holds nothing once the runbook moves past the revision it pinned, and takes it back on re-approval", () => {
		const s = stage();
		s.routines.console.put(routine());

		s.moveRunbook({ id: "book", name: "Book", body: "do something else", parameters: [], revision: 2 });
		expect(s.latest()).toEqual([]);

		// The owner re-approves by saving the routine against the revision now stored.
		expect(s.routines.console.put(routine({ approvedRevision: 2 }), 1).stored).toBe(true);
		expect(s.latest()).toEqual(["deploy"]);
	});

	it("holds nothing once the runbook it pinned is gone", () => {
		const s = stage();
		s.routines.console.put(routine());

		s.moveRunbook(null);
		expect(s.latest()).toEqual([]);
	});
});

const running = async () => {
	const s = stage();
	s.routines.console.put(routine({ linkedEntries: [] }));
	s.at(MONDAY_0900_LA);
	await s.routines.reconcile();
	return s;
};

describe("whose work is open in a session", () => {
	it("is the routine's, while the session is still the one it reserved", async () => {
		const s = await running();

		expect(s.routines.workingRoutine(TEAM)).toBe("triage");
	});

	it("is nobody's once something else holds the name, however the occurrence still reads", async () => {
		const s = await running();

		s.loseSession();

		expect(s.routines.workingRoutine(TEAM)).toBeNull();
	});

	it("is nobody's once that session is closed or forgotten", async () => {
		const s = await running();

		s.routines.sessionEnded(TEAM);

		expect(s.routines.workingRoutine(TEAM)).toBeNull();
	});
});

describe("a secret a routine wanted and never got", () => {
	it("is recorded against the occurrence that asked, and named for the owner", async () => {
		const s = await running();

		s.routines.secretUnanswered(TEAM, "deploy");
		s.routines.secretUnanswered(TEAM, "npm");
		// Asking again is the same want, not a second one.
		s.routines.secretUnanswered(TEAM, "deploy");

		expect(s.wanted("triage")).toEqual({
			occurrenceId: `triage:${MONDAY_0900_LA}`,
			scheduledAt: MONDAY_0900_LA,
			entryIds: ["deploy", "npm"],
		});
	});

	it("is answered by the owner saving the routine, whatever they decided to link", async () => {
		const s = await running();
		s.routines.secretUnanswered(TEAM, "deploy");

		s.routines.console.put(routine({ linkedEntries: ["deploy"] }), 1);

		expect(s.wanted("triage")).toBeUndefined();
	});

	it("is not recorded for a session with no routine working in it", async () => {
		const s = await running();

		s.routines.secretUnanswered("host.something-else", "deploy");

		expect(s.wanted("triage")).toBeUndefined();
	});
});
