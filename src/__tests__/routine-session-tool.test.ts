import { describe, expect, it } from "vitest";
import type { Occurrence } from "../gateway/routines/occurrences.js";
import { answerSessionReport, answerSessionRoutine } from "../gateway/routines/sessionRoutine.js";
import { reportTextOf, textOf } from "../mcp/routines/routineTools.js";
import { MAX_ROUTINE_MEMORY_BYTES } from "../shared/schemasRoutine.js";

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

const ask = (over: {
	team?: string | null;
	rows?: Occurrence[];
	id?: string;
	memory?: { text: string; version: number };
}) =>
	answerSessionRoutine(
		{
			callerTeam: () => (over.team === undefined ? "host.routine-triage" : over.team),
			occurrences: () => over.rows ?? [row()],
			routineName: () => "Morning triage",
			memory: () => over.memory ?? { text: "", version: 0 },
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
			history: "",
			historyVersion: 0,
		});
	});

	it("hands over what earlier runs left, and the version to file against", () => {
		const answer = ask({ memory: { text: "signing keys were refreshed", version: 4 } });
		expect(answer).toMatchObject({ history: "signing keys were refreshed", historyVersion: 4 });
	});

	// The boot check proves the tool is registered and reachable, but asks for an occurrence that is
	// not there. Nothing else reads what a session is actually handed on the way that matters.
	it("hands the instructions on rather than a bare kind", () => {
		expect(
			textOf({
				kind: "instructions",
				routineId: "triage",
				routineName: "Morning triage",
				scheduledAt: 1,
				text: "read the overnight failures",
				history: "",
				historyVersion: 0,
			}),
		).toBe("# Morning triage\n\nread the overnight failures");
		for (const kind of ["no_routine", "unknown_occurrence", "wrong_session", "unauthenticated"] as const) {
			expect(textOf({ kind }).length, kind).toBeGreaterThan(0);
		}
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

const working = (over: Partial<Occurrence> = {}): Occurrence =>
	row({ work: "started", workUntil: 1_700_043_200_000, ...over });

const file = (over: {
	team?: string | null;
	rows?: Occurrence[];
	id?: string;
	until?: number;
	held?: { text: string; version: number };
	history?: string;
	version?: number;
}) => {
	const rows = over.rows ?? [working()];
	const stored = over.held ?? { text: "", version: 0 };
	const filed: Occurrence[] = [];
	const wrote: string[] = [];
	const answer = answerSessionReport(
		{
			callerTeam: () => (over.team === undefined ? "host.routine-triage" : over.team),
			occurrences: () => rows,
			file: (routineId, scheduledAt, _report, memory) => {
				const held = rows.find(
					(candidate) => candidate.routineId === routineId && candidate.scheduledAt === scheduledAt,
				);
				if (!held) return { kind: "refused" };
				if (!memory.force && stored.version !== memory.base) return { kind: "conflict", current: stored };
				wrote.push(memory.text);
				const moved = {
					...held,
					workUntil: Math.min(held.workUntil ?? held.deadlineAt, over.until ?? 1_700_001_800_000),
				};
				filed.push(moved);
				return { kind: "filed", occurrence: moved };
			},
		},
		over.id ?? "1700000000000",
		"apt upgraded, nothing held back",
		over.history ?? "keys refreshed",
		over.version ?? 0,
	);
	return { answer, filed, wrote };
};

describe("a routine session filing its own report", () => {
	it("narrows the window the run's authority lives in", () => {
		const { answer, filed } = file({});
		expect(answer).toEqual({
			kind: "filed",
			routineId: "triage",
			scheduledAt: 1_700_000_000_000,
			workUntil: 1_700_001_800_000,
		});
		expect(filed).toHaveLength(1);
	});

	// Filing again must not buy another window, or a session holds its secrets open one report at a
	// time. The store floors it; this proves the answer reports the floored value rather than the ask.
	it("never pushes the window back out", () => {
		const narrowed = working({ workUntil: 1_700_000_600_000 });
		const { answer } = file({ rows: [narrowed], until: 1_700_009_999_999 });
		expect(answer).toEqual({
			kind: "filed",
			routineId: "triage",
			scheduledAt: 1_700_000_000_000,
			workUntil: 1_700_000_600_000,
		});
	});

	it("refuses a run that is over, and writes nothing", () => {
		for (const over of [working({ work: "done" }), working({ work: undefined }), working({ state: "due" })]) {
			const { answer, filed } = file({ rows: [over] });
			expect(answer.kind).toBe("not_working");
			expect(filed).toHaveLength(0);
		}
	});

	it("resolves the caller exactly as the instructions question does", () => {
		expect(file({ team: null }).answer.kind).toBe("unauthenticated");
		expect(file({ team: "host.someone-else" }).answer.kind).toBe("no_routine");
		expect(file({ id: "1700000009999" }).answer.kind).toBe("unknown_occurrence");

		const theirs = working({ team: "host.routine-other", scheduledAt: 1_700_000_000_001 });
		expect(file({ rows: [working(), theirs], id: "1700000000001" }).answer.kind).toBe("wrong_session");
	});

	it("says each outcome rather than leaving a bare kind", () => {
		expect(
			reportTextOf({ kind: "filed", routineId: "triage", scheduledAt: 1, workUntil: 1_700_001_800_000 }),
		).toContain("filed");
		for (const kind of [
			"not_working",
			"no_routine",
			"unknown_occurrence",
			"wrong_session",
			"unauthenticated",
		] as const) {
			expect(reportTextOf({ kind }).length, kind).toBeGreaterThan(0);
		}
	});

	// The owner's rule: bounce exactly once, hand back the truth, take whatever comes next.
	it("bounces a run whose history moved, and hands back what is held", () => {
		const { answer, wrote } = file({ held: { text: "someone else wrote this", version: 5 }, version: 4 });
		expect(answer).toEqual({
			kind: "history_conflict",
			history: "someone else wrote this",
			historyVersion: 5,
		});
		expect(wrote).toHaveLength(0);
	});

	it("takes the second filing from a run it already bounced", () => {
		const bounced = working({ memoryBounced: true });
		const { answer, wrote } = file({
			rows: [bounced],
			held: { text: "someone else wrote this", version: 5 },
			version: 4,
			history: "consolidated",
		});
		expect(answer.kind).toBe("filed");
		expect(wrote).toEqual(["consolidated"]);
	});

	it("refuses a history too large to remember, before anything is written", () => {
		const { answer, filed, wrote } = file({ history: "x".repeat(MAX_ROUTINE_MEMORY_BYTES + 1) });
		expect(answer).toEqual({ kind: "history_too_large", maxBytes: MAX_ROUTINE_MEMORY_BYTES });
		expect(filed).toHaveLength(0);
		expect(wrote).toHaveLength(0);
	});

	// Bytes, not characters: the bound is on the file, and one character can be four of them.
	it("measures the bound in bytes", () => {
		const justOver = "é".repeat(MAX_ROUTINE_MEMORY_BYTES / 2 + 1);
		expect(justOver.length).toBeLessThan(MAX_ROUTINE_MEMORY_BYTES);
		expect(file({ history: justOver }).answer.kind).toBe("history_too_large");
	});
});
