import { describe, expect, it } from "vitest";
import type { Occurrence } from "../gateway/routines/occurrences.js";
import { answerSessionRoutine } from "../gateway/routines/sessionRoutine.js";

const row = (over: Partial<Occurrence> = {}): Occurrence => ({
	routineId: "triage",
	scheduledAt: 1_700_000_000_000,
	deadlineAt: 1_700_043_200_000,
	state: "dispatched",
	version: 2,
	snapshot: "read the overnight failures",
	team: "host.routine-triage",
	...over,
});

const ask = (over: { team?: string | null; rows?: Occurrence[]; id?: string }) =>
	answerSessionRoutine(
		{
			callerTeam: () => (over.team === undefined ? "host.routine-triage" : over.team),
			occurrences: () => over.rows ?? [row()],
			routineName: () => "Morning triage",
		},
		over.id ?? "1700000000000",
	);

describe("what a routine's session may ask back", () => {
	it("answers the snapshot taken when the occurrence was prepared", () => {
		expect(ask({})).toEqual({
			kind: "instructions",
			routineId: "triage",
			routineName: "Morning triage",
			scheduledAt: 1_700_000_000_000,
			text: "read the overnight failures",
		});
	});

	it("keeps the four failures apart", () => {
		expect(ask({ team: null }).kind).toBe("unauthenticated");
		expect(ask({ team: "host.someone-else" }).kind).toBe("no_routine");
		expect(ask({ id: "1700000009999" }).kind).toBe("unknown_occurrence");

		// The occurrence exists, on a session that is not this one.
		const theirs = row({ team: "host.routine-other", scheduledAt: 1_700_000_000_001 });
		expect(ask({ rows: [row(), theirs], id: "1700000000001" }).kind).toBe("wrong_session");
	});

	it("does not answer an occurrence that was never prepared", () => {
		const bare = row({ snapshot: undefined, state: "due" });
		expect(ask({ rows: [bare] }).kind).toBe("no_routine");
	});
});
