// What a routine's own session may ask back, and the ways those questions can fail.

import type { SessionReportAnswer } from "../../shared/schemasRoutine.js";
import type { Occurrence } from "./occurrences.js";

export type SessionRoutineAnswer =
	| { kind: "instructions"; routineId: string; routineName: string; scheduledAt: number; text: string }
	/** The caller is a session, and no routine runs on it. */
	| { kind: "no_routine" }
	/** A routine runs here, but not that occurrence. */
	| { kind: "unknown_occurrence" }
	/** That occurrence belongs to a different session, and asking learns nothing else about it. */
	| { kind: "wrong_session" }
	| { kind: "unauthenticated" };

export interface SessionRoutineDeps {
	/** The team the caller's token resolves to, or null when it resolves to nothing. */
	callerTeam: () => string | null;
	occurrences: () => Occurrence[];
	routineName: (routineId: string) => string | null;
}

/**
 * Answers the snapshot taken when the occurrence was prepared, never a fresh render. Rendering again
 * would let a runbook edited on Tuesday rewrite instructions issued on Monday, which is the approval
 * binding leaking away through a side door.
 */
export function answerSessionRoutine(deps: SessionRoutineDeps, occurrenceId: string): SessionRoutineAnswer {
	const team = deps.callerTeam();
	if (!team) return { kind: "unauthenticated" };

	const rows = deps.occurrences();
	const mine = rows.filter((row) => row.team === team && row.snapshot !== undefined);
	if (mine.length === 0) return { kind: "no_routine" };

	const wanted = String(occurrenceId);
	const held = mine.find((row) => String(row.scheduledAt) === wanted);
	if (!held) {
		// Separating these does say that some instant is spoken for, which a session could probe
		// for. It is kept because a session told "unknown" about its own run, after a session was
		// replaced underneath it, would report a routine broken that is merely somewhere else.
		const elsewhere = rows.some((row) => String(row.scheduledAt) === wanted && row.team !== team);
		return elsewhere ? { kind: "wrong_session" } : { kind: "unknown_occurrence" };
	}

	return {
		kind: "instructions",
		routineId: held.routineId,
		routineName: deps.routineName(held.routineId) ?? held.routineId,
		scheduledAt: held.scheduledAt,
		text: held.snapshot as string,
	};
}

export interface SessionReportDeps {
	callerTeam: () => string | null;
	occurrences: () => Occurrence[];
	/** Writes the words and pulls the window in. Null when the row would not take it. */
	file: (routineId: string, scheduledAt: number, report: string) => Occurrence | null;
}

/**
 * Files a run's own account of itself, which is what narrows its authority. Resolved exactly as the
 * instructions question is, so a session cannot report against a run that is not its own.
 *
 * A run already over is told so rather than silently accepted: its window needs no narrowing and the
 * session should know its authority has already gone.
 */
export function answerSessionReport(
	deps: SessionReportDeps,
	occurrenceId: string,
	report: string,
): SessionReportAnswer {
	const team = deps.callerTeam();
	if (!team) return { kind: "unauthenticated" };

	const rows = deps.occurrences();
	const mine = rows.filter((row) => row.team === team && row.snapshot !== undefined);
	if (mine.length === 0) return { kind: "no_routine" };

	const wanted = String(occurrenceId);
	const held = mine.find((row) => String(row.scheduledAt) === wanted);
	if (!held) {
		const elsewhere = rows.some((row) => String(row.scheduledAt) === wanted && row.team !== team);
		return elsewhere ? { kind: "wrong_session" } : { kind: "unknown_occurrence" };
	}

	if (held.state !== "dispatched" || held.work === undefined || held.work === "done") {
		return { kind: "not_working" };
	}

	const filed = deps.file(held.routineId, held.scheduledAt, report);
	if (!filed) return { kind: "not_working" };
	return {
		kind: "filed",
		routineId: filed.routineId,
		scheduledAt: filed.scheduledAt,
		workUntil: filed.workUntil ?? filed.deadlineAt,
	};
}
