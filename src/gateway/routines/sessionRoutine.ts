// What a routine's own session may ask back, and the ways those questions can fail.

import {
	MAX_ROUTINE_MEMORY_BYTES,
	type SessionReportAnswer,
	type SessionRoutineAnswer,
} from "../../shared/schemasRoutine.js";
import type { Occurrence } from "./occurrences.js";

export interface SessionRoutineDeps {
	/** The team the caller's token resolves to, or null when it resolves to nothing. */
	callerTeam: () => string | null;
	occurrences: () => Occurrence[];
	routineName: (routineId: string) => string | null;
	/** What this routine remembers from earlier runs, empty at version zero on its first. */
	memory: (routineId: string) => { text: string; version: number };
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

	const remembered = deps.memory(held.routineId);
	return {
		kind: "instructions",
		routineId: held.routineId,
		routineName: deps.routineName(held.routineId) ?? held.routineId,
		scheduledAt: held.scheduledAt,
		text: held.snapshot as string,
		history: remembered.text,
		historyVersion: remembered.version,
	};
}

export interface SessionReportDeps {
	callerTeam: () => string | null;
	occurrences: () => Occurrence[];
	/**
	 * Runs the whole filing: the occurrence write, then the memory write, in that order. Answers what
	 * the store made of it, so the decision here never touches two stores itself.
	 */
	file: (
		routineId: string,
		scheduledAt: number,
		report: string,
		memory: { text: string; base: number; force: boolean },
	) => FileOutcome;
}

export type FileOutcome =
	| { kind: "filed"; occurrence: Occurrence }
	| { kind: "conflict"; current: { text: string; version: number } }
	| { kind: "refused" };

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
	history: string,
	historyVersion: number,
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

	if (Buffer.byteLength(history, "utf8") > MAX_ROUTINE_MEMORY_BYTES) {
		return { kind: "history_too_large", maxBytes: MAX_ROUTINE_MEMORY_BYTES };
	}

	// Already bounced once, so this filing is taken as it stands rather than bouncing again. Two runs
	// that kept refusing each other would never close either window.
	const outcome = deps.file(held.routineId, held.scheduledAt, report, {
		text: history,
		base: historyVersion,
		force: held.memoryBounced === true,
	});
	if (outcome.kind === "refused") return { kind: "not_working" };
	if (outcome.kind === "conflict") {
		return {
			kind: "history_conflict",
			history: outcome.current.text,
			historyVersion: outcome.current.version,
		};
	}
	const filed = outcome.occurrence;
	return {
		kind: "filed",
		routineId: filed.routineId,
		scheduledAt: filed.scheduledAt,
		workUntil: filed.workUntil ?? filed.deadlineAt,
	};
}
