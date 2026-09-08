import { describe, expect, it } from "vitest";
import { type Routine, RoutineSchema, routineRefusal } from "../shared/schemasRoutine.js";

const routine = (over: Partial<Routine> = {}): Routine => ({
	id: "r1",
	name: "Morning triage",
	weekdays: [1, 3, 5],
	weekInterval: 1,
	startDate: "2026-09-07",
	time: "09:00",
	zone: "America/Los_Angeles",
	runbookId: "triage",
	approvedRevision: 4,
	values: { branch: "main" },
	target: { spawn: "host" },
	enabled: true,
	revision: 1,
	...over,
});

describe("what a routine may be", () => {
	it("takes an ordinary one", () => {
		expect(routineRefusal(routine())).toBeNull();
		expect(RoutineSchema.safeParse(routine()).success).toBe(true);
	});

	it("refuses a schedule that would never come around", () => {
		expect(routineRefusal(routine({ weekdays: [] }))).toContain("never fire");
		expect(routineRefusal(routine({ weekdays: [1, 1, 3] }))).toContain("twice");
	});

	it("refuses a date, time or zone it cannot read", () => {
		expect(routineRefusal(routine({ startDate: "07-09-2026" }))).toContain("not a date");
		expect(routineRefusal(routine({ startDate: "2026-02-30" }))).toContain("not a date");
		expect(routineRefusal(routine({ time: "9:00" }))).toContain("not a time");
		expect(routineRefusal(routine({ time: "24:00" }))).toContain("not a time");
		expect(routineRefusal(routine({ zone: "Mars/Olympus" }))).toContain("not a zone");
	});

	it("holds the schema to the ranges the editor offers", () => {
		expect(RoutineSchema.safeParse(routine({ weekdays: [0] })).success).toBe(false);
		expect(RoutineSchema.safeParse(routine({ weekdays: [8] })).success).toBe(false);
		expect(RoutineSchema.safeParse(routine({ weekInterval: 0 })).success).toBe(false);
		expect(RoutineSchema.safeParse(routine({ weekInterval: 9 })).success).toBe(false);
		expect(RoutineSchema.safeParse(routine({ approvedRevision: 0 })).success).toBe(false);
	});

	it("accepts the sparsest schedule the editor can make", () => {
		expect(routineRefusal(routine({ weekdays: [7], weekInterval: 8 }))).toBeNull();
	});
});
