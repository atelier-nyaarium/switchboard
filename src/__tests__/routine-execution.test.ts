import { describe, expect, it, vi } from "vitest";
import { createRoutineExecution, nudgeFor } from "../gateway/routines/execution.js";
import type { Occurrence } from "../gateway/routines/occurrences.js";
import { routineTeam } from "../gateway/routines/reservation.js";
import type { Routine } from "../shared/schemasRoutine.js";
import type { Runbook } from "../shared/schemasRunbook.js";

const runbook = (over: Partial<Runbook> = {}): Runbook => ({
	id: "book",
	name: "Triage",
	body: "read {{branch}}",
	parameters: [{ name: "branch", label: "Branch", kind: "text" }],
	revision: 3,
	...over,
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
	approvedRevision: 3,
	values: { branch: "main" },
	target: { spawn: "host" },
	enabled: true,
	revision: 1,
	since: 0,
	...over,
});

const occurrence: Occurrence = {
	routineId: "triage",
	scheduledAt: 1_757_260_800_000,
	deadlineAt: 1_757_303_999_999,
	state: "due",
	version: 1,
};

function seam(over: Partial<Parameters<typeof createRoutineExecution>[0]> = {}) {
	const delivered: Array<{ from: string; to: string; body: string; deliveryId: string }> = [];
	const execution = createRoutineExecution({
		getRunbook: () => runbook(),
		workingOf: () => undefined,
		reserveSession: async (r) => ({ kind: "ok", team: routineTeam(r) }),
		deliver: async (nudge) => {
			delivered.push(nudge);
			return null;
		},
		...over,
	});
	return { execution, delivered };
}

describe("what a routine does when its moment comes", () => {
	it("renders the approved revision and binds the routine's own session", async () => {
		const { execution } = seam();

		const prepared = await execution.prepare(routine(), occurrence);

		expect(prepared).toEqual({ ok: true, revision: 3, snapshot: "read main", team: "host.routine-triage" });
	});

	it("refuses for review when the words that would run are not the ones approved", async () => {
		for (const held of [runbook({ revision: 4 }), null]) {
			const { execution } = seam({ getRunbook: () => held });
			expect(await execution.prepare(routine(), occurrence)).toEqual({ ok: false, reason: "revision_moved" });
		}
	});

	it("answers unreachable rather than throwing, whether the host refused or is still launching", async () => {
		const throwing = seam({
			reserveSession: async () => {
				throw new Error("the host is not connected");
			},
		});
		const launching = seam({ reserveSession: async () => ({ kind: "pending" }) });

		for (const { execution } of [throwing, launching]) {
			expect(await execution.prepare(routine(), occurrence)).toEqual({ ok: false, reason: "unreachable" });
		}
	});

	it("refuses for review when something else holds the session it reserves", async () => {
		const { execution } = seam({ reserveSession: async () => ({ kind: "taken" }) });

		expect(await execution.prepare(routine(), occurrence)).toEqual({ ok: false, reason: "session_taken" });
	});

	it("treats a session nobody has heard from as idle, and only a working one as busy", () => {
		const states = [undefined, false, true] as const;
		const idle = states.map((working) => seam({ workingOf: () => working }).execution.sessionIdle(routine()));

		expect(idle).toEqual([true, true, false]);
	});

	it("nudges the session the occurrence was bound to, not the one derived now", async () => {
		const { execution, delivered } = seam();

		await execution.deliver(routine(), { ...occurrence, team: "host.routine-old" });

		expect(delivered).toEqual([
			{
				from: "routine-triage",
				to: "host.routine-old",
				body: nudgeFor(routine(), occurrence),
				deliveryId: `triage:${occurrence.scheduledAt}`,
			},
		]);
	});

	it("says a refused nudge was lost rather than letting it end the sweep", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { execution } = seam({
			deliver: async () => {
				throw new Error("the machine is not reachable");
			},
		});

		await expect(execution.deliver(routine(), occurrence)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
