// A routine is a schedule the gateway runs, bound to a stored runbook.

import { z } from "zod";
import { instantOf, type LocalDate, nextOccurrence, parseLocalDate, parseLocalTime } from "./routine-recurrence.js";
import { CLI_PICKS } from "./session-harness.js";
import { MAX_SLUG_LEN, SLUG_RE } from "./session-id.js";
import { ROUTINE_FORGET_DAYS_MAX, ROUTINE_FORGET_DAYS_MIN } from "./wire-vocabulary.js";

/** Eight weeks is the longest interval the editor offers. */
const MAX_WEEK_INTERVAL = 8;

const ROUTINE_SESSION_PREFIX = "routine-";

export function forgetAfterMs(routine: { forgetAfterDays: number }): number {
	return routine.forgetAfterDays * 24 * 60 * 60 * 1000;
}

/** The id has to leave a valid session segment, since the reserved session is named from it. */
export const MAX_ROUTINE_ID_LEN = MAX_SLUG_LEN - ROUTINE_SESSION_PREFIX.length;

/** An id already carrying the prefix keeps it. */
export function routineSessionName(routineId: string): string {
	if (routineId.startsWith(ROUTINE_SESSION_PREFIX)) return routineId;
	return `${ROUTINE_SESSION_PREFIX}${routineId}`;
}

/** A policy, not a session id, since a session can close; resolved just before firing. */
export const ROUTINE_TARGET_KINDS = ["spawn", "assistant"] as const;

export type RoutineTargetKind = (typeof ROUTINE_TARGET_KINDS)[number];

export const RoutineTargetSchema = z
	.object({
		/** A check-in runs in the assistant's session. Absent means spawn. Required from 2026-11-07. */
		kind: z.enum(ROUTINE_TARGET_KINDS).meta({ id: "RoutineTargetKind" }).optional(),
		/** A spawn point here. A check-in keeps the assistant's, so an older phone decodes it. */
		spawn: z.string().min(1).max(128),
		workdir: z.string().min(1).optional(),
		/** Absent keeps the held pick; `unpicked` clears it. */
		cli: z.enum(CLI_PICKS).optional(),
	})
	.meta({ id: "RoutineTarget" });

export type RoutineTarget = z.infer<typeof RoutineTargetSchema>;

export function targetKind(target: RoutineTarget): RoutineTargetKind {
	return target.kind ?? "spawn";
}

export function isCheckIn(routine: Pick<Routine, "target">): boolean {
	return targetKind(routine.target) === "assistant";
}

/** Routine ids distinguish same-time runs. */
export function occurrenceIdOf(routineId: string, scheduledAt: number): string {
	return `${routineId}${OCCURRENCE_ID_SEPARATOR}${scheduledAt}`;
}

const OCCURRENCE_ID_SEPARATOR = "@";

/** Fits routine id, separator, instant. */
export const MAX_OCCURRENCE_ID_LEN = 128;

/** A bare instant names no routine. */
export function parseOccurrenceId(id: string): { routineId?: string; scheduledAt: string } {
	const at = id.lastIndexOf(OCCURRENCE_ID_SEPARATOR);
	if (at < 0) return { scheduledAt: id };
	return { routineId: id.slice(0, at), scheduledAt: id.slice(at + 1) };
}

export const RoutineSchema = z
	.object({
		id: z.string().min(1).max(MAX_ROUTINE_ID_LEN).regex(SLUG_RE),
		name: z.string().min(1),
		/** ISO weekdays it fires on. Monday is 1. */
		weekdays: z.array(z.number().int().min(1).max(7)),
		/** 1 is every week, 2 every other. */
		weekInterval: z.number().int().min(1).max(MAX_WEEK_INTERVAL),
		/** The date the week count runs from, as YYYY-MM-DD. */
		startDate: z.string(),
		/** As HH:MM. */
		time: z.string(),
		/** Zone the calendar fields read in. */
		zone: z.string().min(1),
		runbookId: z.string().min(1),
		/** Last revision shown by the editor. */
		approvedRevision: z.number().int().positive(),
		/** Complete at save, so nothing is asked at fire time. */
		values: z.record(z.string(), z.string()),
		target: RoutineTargetSchema,
		/** Entries pre-authorized at save, unrestricted while an occurrence is live. */
		linkedEntries: z.array(z.string().min(1).max(64)).max(16),
		enabled: z.boolean(),
		/** Bumped by the gateway on every save, so a stale editor cannot land on a moved record. */
		revision: z.number().int().positive(),
		/** When the gateway first took it; recovery cannot reach past. */
		since: z.number().int().nonnegative(),
		/** Days a finished run's reserved session is kept before the gateway forgets it. */
		forgetAfterDays: z.number().int().min(ROUTINE_FORGET_DAYS_MIN).max(ROUTINE_FORGET_DAYS_MAX),
		/** Minted at first store, kept across edits; a reused id gets a new one. */
		incarnation: z.string().min(1).max(64).optional(),
	})
	.meta({ id: "Routine" });

export type Routine = z.infer<typeof RoutineSchema>;

/** An occurrence the owner has not dealt with, drawn from its current state rather than a row. */
export const RoutineMissSchema = z
	.object({
		occurrenceId: z.string().min(1),
		/** The instant it was meant to run, frozen when the occurrence was made. */
		scheduledAt: z.number().int().nonnegative(),
		/** Being down, staying busy and being unreachable share a deadline but not a story. */
		reason: z.string(),
		/** False once the twelve hours are gone, so the panel offers Dismiss alone. */
		runnable: z.boolean(),
	})
	.meta({ id: "RoutineMiss" });

/** Secrets an occurrence asked for and never got. */
export const RoutineAttentionSchema = z
	.object({
		occurrenceId: z.string().min(1),
		scheduledAt: z.number().int().nonnegative(),
		entryIds: z.array(z.string().min(1)),
	})
	.meta({ id: "RoutineAttention" });

/** What the phone draws a row from. It recomputes no instant of its own. */
export const RoutineStateSchema = z
	.object({
		routine: RoutineSchema,
		/** Absent when disabled, or when the rule names nothing further. */
		nextAt: z.number().int().nonnegative().optional(),
		lastRanAt: z.number().int().nonnegative().optional(),
		/** When that run's session read its instructions. Absent means it never did. */
		lastReadAt: z.number().int().nonnegative().optional(),
		missed: RoutineMissSchema.optional(),
		/** When a run last stopped for review. */
		reviewAt: z.number().int().nonnegative().optional(),
		/** Why, as it stands now. */
		reviewReason: z.string().optional(),
		/** A run waiting now, by its miss reason. */
		waiting: z.string().optional(),
		attention: RoutineAttentionSchema.optional(),
	})
	.meta({ id: "RoutineState" });

export const ConsoleRoutineListResultSchema = z
	.object({
		routines: z.array(RoutineStateSchema),
		// FIXME 2026-11-23: remove. Older apps require it.
		zone: z.string().min(1).optional(),
	})
	.meta({ id: "ConsoleRoutineListResult" });

export const ConsoleRoutinePutResultSchema = z
	.object({
		stored: z.boolean(),
		/** What the gateway holds after the write. */
		revision: z.number().int().nonnegative(),
		/** The stored record. */
		routine: RoutineSchema.optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "ConsoleRoutinePutResult" });

/** Null when nothing further; required, since an all-optional answer matches anything. */
export const ConsoleRoutineNextResultSchema = z
	.object({ nextAt: z.number().int().nonnegative().nullable(), reason: z.string().optional() })
	.meta({ id: "ConsoleRoutineNextResult" });

export const ConsoleRoutineDeleteResultSchema = z
	.object({ deleted: z.boolean() })
	.meta({ id: "ConsoleRoutineDeleteResult" });

/** Run now and Dismiss both answer whether the CAS took, never whether the work went well. */
export const ConsoleRoutineOccurrenceResultSchema = z
	.object({
		applied: z.boolean(),
		reason: z.string().optional(),
	})
	.meta({ id: "ConsoleRoutineOccurrenceResult" });

/** Names the occurrence it opened. */
export const ConsoleRoutineRunResultSchema = z
	.object({
		ran: z.boolean(),
		occurrenceId: z.string().min(1).max(128).optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "ConsoleRoutineRunResult" });

/** Session wire, not phone wire: no `.meta` id, no Kotlin. */
export const SessionRoutineRequestShape = {
	occurrenceId: z.string().min(1).max(MAX_OCCURRENCE_ID_LEN).describe(`Occurrence id from the nudge.`),
};

export const SessionRoutineRequestSchema = z.object(SessionRoutineRequestShape);

export const SessionRoutineAnswerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("instructions"),
		routineId: z.string(),
		routineName: z.string(),
		scheduledAt: z.number().int(),
		text: z.string(),
		/** What earlier runs of this routine chose to carry forward. Empty on its first run. */
		history: z.string(),
		/** The version that history is at, which the report files against. */
		historyVersion: z.number().int().nonnegative(),
	}),
	z.object({ kind: z.literal("no_routine") }),
	z.object({ kind: z.literal("unknown_occurrence") }),
	z.object({ kind: z.literal("wrong_session") }),
	z.object({ kind: z.literal("unauthenticated") }),
]);

export type SessionRoutineRequest = z.infer<typeof SessionRoutineRequestSchema>;
export type SessionRoutineAnswer = z.infer<typeof SessionRoutineAnswerSchema>;

/** What a filed report leaves of the work window. */
export const ROUTINE_REPORT_GRACE_MS = 30 * 60 * 1000;

/** Bounded so a runaway session cannot write the occurrence file to the disk's end. */
export const MAX_ROUTINE_REPORT_CHARS = 16_384;

/** UTF-8 bytes, not characters. Oversized is refused, never trimmed. */
export const MAX_ROUTINE_MEMORY_BYTES = 32_768;

export const SessionReportRequestShape = {
	occurrenceId: z.string().min(1).max(MAX_OCCURRENCE_ID_LEN).describe(`Occurrence id from the nudge.`),
	report: z
		.string()
		.min(1)
		.max(MAX_ROUTINE_REPORT_CHARS)
		.describe(`What the run did and what it left, in the run's own words.`),
	history: z
		// Coarse pre-bound; the byte check answers `history_too_large`.
		.string()
		.max(MAX_ROUTINE_MEMORY_BYTES)
		.describe(`The history you were handed, amended with what this run learned. Carried to the next run.`),
	historyVersion: z
		.number()
		.int()
		.nonnegative()
		.describe(`The historyVersion you were handed, so a run that moved it since is caught.`),
};

export const SessionReportRequestSchema = z.object(SessionReportRequestShape);

export const SessionReportAnswerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("filed"),
		routineId: z.string(),
		scheduledAt: z.number().int(),
		/** What the window now ends at, which a second filing never pushes out. */
		workUntil: z.number().int(),
	}),
	z.object({ kind: z.literal("no_routine") }),
	z.object({ kind: z.literal("unknown_occurrence") }),
	z.object({ kind: z.literal("wrong_session") }),
	z.object({ kind: z.literal("unauthenticated") }),
	/** The run is over, by its window or its session ending. Nothing left to narrow. */
	z.object({ kind: z.literal("not_working") }),
	/** Bounces once: the next filing is taken as it stands. */
	z.object({
		kind: z.literal("history_conflict"),
		history: z.string(),
		historyVersion: z.number().int().nonnegative(),
	}),
	/** The history handed back is larger than a routine may remember. Shorten it and file again. */
	z.object({ kind: z.literal("history_too_large"), maxBytes: z.number().int().positive() }),
]);

export type SessionReportRequest = z.infer<typeof SessionReportRequestSchema>;
export type SessionReportAnswer = z.infer<typeof SessionReportAnswerSchema>;

export type RoutineAttention = z.infer<typeof RoutineAttentionSchema>;
export type RoutineMiss = z.infer<typeof RoutineMissSchema>;
export type RoutineState = z.infer<typeof RoutineStateSchema>;
export type ConsoleRoutineListResult = z.infer<typeof ConsoleRoutineListResultSchema>;
export type ConsoleRoutinePutResult = z.infer<typeof ConsoleRoutinePutResultSchema>;
export type ConsoleRoutineNextResult = z.infer<typeof ConsoleRoutineNextResultSchema>;
export type ConsoleRoutineDeleteResult = z.infer<typeof ConsoleRoutineDeleteResultSchema>;
export type ConsoleRoutineOccurrenceResult = z.infer<typeof ConsoleRoutineOccurrenceResultSchema>;
export type ConsoleRoutineRunResult = z.infer<typeof ConsoleRoutineRunResultSchema>;

/** Why a routine cannot be stored, or null. */
export function routineRefusal(routine: Routine): string | null {
	if (routine.weekdays.length === 0) return "a routine with no weekday would never fire";
	if (new Set(routine.weekdays).size !== routine.weekdays.length) return "a weekday is named twice";
	if (new Set(routine.linkedEntries).size !== routine.linkedEntries.length) return "a secret is linked twice";
	if (isCheckIn(routine) && routine.linkedEntries.length > 0) return "a check-in reaches no secrets";
	if (!parseLocalDate(routine.startDate)) return `${routine.startDate} is not a date`;
	if (!parseLocalTime(routine.time)) return `${routine.time} is not a time`;
	if (!knownZone(routine.zone)) return `${routine.zone} is not a zone this gateway knows`;

	// A rule that parses can still name nothing, so ask the calculator rather than trust the parse.
	const rule = {
		weekdays: routine.weekdays,
		weekInterval: routine.weekInterval,
		startDate: routine.startDate,
		time: routine.time,
		zone: routine.zone,
	};
	const start = parseLocalDate(routine.startDate) as LocalDate;
	if (nextOccurrence(rule, instantOf(routine.zone, start, 0, 0) - 1) === null) {
		return "this schedule never comes around";
	}
	return null;
}

function knownZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}
