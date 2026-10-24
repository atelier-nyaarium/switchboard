// What a routine's own session may ask back, and the ways those questions can fail.

import {
	MAX_ROUTINE_MEMORY_BYTES,
	parseOccurrenceId,
	type SessionReportAnswer,
	type SessionRoutineAnswer,
} from "../../shared/schemasRoutine.js";
import { type Occurrence, workEnded } from "./occurrences.js";

export interface SessionRoutineDeps {
	/** The team the caller's token resolves to, or null when it resolves to nothing. */
	callerTeam: () => string | null;
	occurrences: () => Occurrence[];
	routineName: (routineId: string) => string | null;
	/** What this routine remembers from earlier runs, empty at version zero on its first. */
	memory: (routineId: string) => { text: string; version: number };
}

type Found =
	| { kind: "held"; row: Occurrence }
	| { kind: "no_routine" }
	| { kind: "wrong_session" }
	| { kind: "unknown_occurrence" };

/**
 * The caller's run an id names. Both questions resolve here, so a session cannot read one run and
 * report another. A bare instant, from a nudge in flight, counts only when it names one run.
 */
function findOccurrence(rows: Occurrence[], team: string, occurrenceId: string): Found {
	const mine = rows.filter((row) => row.team === team && row.snapshot !== undefined);
	if (mine.length === 0) return { kind: "no_routine" };

	const named = parseOccurrenceId(String(occurrenceId));
	const names = (row: Occurrence) =>
		String(row.scheduledAt) === named.scheduledAt &&
		(named.routineId === undefined || row.routineId === named.routineId);
	const held = mine.filter(names);
	if (held.length === 1) return { kind: "held", row: held[0] as Occurrence };
	if (held.length > 1) return { kind: "unknown_occurrence" };
	// Separating these does say that some instant is spoken for, which a session could probe
	// for. It is kept because a session told "unknown" about its own run, after a session was
	// replaced underneath it, would report a routine broken that is merely somewhere else.
	const elsewhere = rows.some((row) => names(row) && row.team !== team);
	return elsewhere ? { kind: "wrong_session" } : { kind: "unknown_occurrence" };
}

/**
 * Answers the snapshot taken when the occurrence was prepared, never a fresh render. Rendering again
 * would let a runbook edited on Tuesday rewrite instructions issued on Monday, which is the approval
 * binding leaking away through a side door.
 */
export function answerSessionRoutine(deps: SessionRoutineDeps, occurrenceId: string): SessionRoutineAnswer {
	const team = deps.callerTeam();
	if (!team) return { kind: "unauthenticated" };

	const found = findOccurrence(deps.occurrences(), team, occurrenceId);
	if (found.kind !== "held") return found;
	const held = found.row;

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

	const found = findOccurrence(deps.occurrences(), team, occurrenceId);
	if (found.kind !== "held") return found;
	const held = found.row;

	if (workEnded(held)) return { kind: "not_working" };

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
