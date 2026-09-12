// A routine is a schedule the gateway runs, bound to a runbook the owner already approved.

import { z } from "zod";
import { instantOf, type LocalDate, nextOccurrence, parseLocalDate, parseLocalTime } from "./routine-recurrence.js";
import { MAX_SLUG_LEN, SLUG_RE } from "./session-id.js";
import { ROUTINE_FORGET_DAYS_DEFAULT, ROUTINE_FORGET_DAYS_MAX, ROUTINE_FORGET_DAYS_MIN } from "./wire-vocabulary.js";

/** Eight weeks is the longest interval the editor offers. */
const MAX_WEEK_INTERVAL = 8;

const ROUTINE_SESSION_PREFIX = "routine-";

/** The owner's choice, or the default a console too old to carry one implies. */
export function forgetAfterMs(routine: { forgetAfterDays?: number }): number {
	return (routine.forgetAfterDays ?? ROUTINE_FORGET_DAYS_DEFAULT) * 24 * 60 * 60 * 1000;
}

/** The id has to leave a valid session segment, since the reserved session is named from it. */
export const MAX_ROUTINE_ID_LEN = MAX_SLUG_LEN - ROUTINE_SESSION_PREFIX.length;

/**
 * Where a routine's reserved session lives. The one place that name is made.
 *
 * An id that already carries the prefix keeps it rather than earning a second one: the prefix
 * names the session, so applying it twice names nothing. Stored ids from earlier builds carry it.
 */
export function routineSessionName(routineId: string): string {
	if (routineId.startsWith(ROUTINE_SESSION_PREFIX)) return routineId;
	return `${ROUTINE_SESSION_PREFIX}${routineId}`;
}

/**
 * Where the reserved session is made. A policy rather than a session id, because the id would bake
 * in a session that can be closed, and the occurrence resolves this immediately before firing.
 */
export const RoutineTargetSchema = z
	.object({
		/** A spawn point on this gateway. */
		spawn: z.string().min(1).max(128),
		workdir: z.string().min(1).optional(),
	})
	.meta({ id: "RoutineTarget" });

export type RoutineTarget = z.infer<typeof RoutineTargetSchema>;

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
		/**
		 * The zone every calendar field above is read in, recorded at save. Without it the canonical
		 * zone would be a line in the Dockerfile, and editing that line would reinterpret every
		 * stored routine at once.
		 */
		zone: z.string().min(1),
		runbookId: z.string().min(1),
		/** The revision the owner approved. A runbook that moves past it stops this routine. */
		approvedRevision: z.number().int().positive(),
		/** Complete at save, so nothing is asked at fire time. */
		values: z.record(z.string(), z.string()),
		target: RoutineTargetSchema,
		/**
		 * Vault entries the owner pre-authorized at save. Each is unrestricted while an occurrence is
		 * live: the grant names the entry and claims nothing about what is run with it.
		 */
		linkedEntries: z.array(z.string().min(1).max(64)).max(16),
		enabled: z.boolean(),
		/** Bumped by the gateway on every save, so a stale editor cannot land on a moved record. */
		revision: z.number().int().positive(),
		/**
		 * When this gateway first took the routine, set by it and carried across edits. Recovery
		 * cannot reach past it, so a routine saved today is never handed a miss for last month.
		 */
		since: z.number().int().nonnegative(),
		/**
		 * Days a finished run's reserved session is kept before the gateway forgets it. Absent reads
		 * as the default, which is what a console that has not shipped this field sends.
		 */
		// Required from 2026-09-25, by when every console has it.
		forgetAfterDays: z.number().int().min(ROUTINE_FORGET_DAYS_MIN).max(ROUTINE_FORGET_DAYS_MAX).optional(),
		/**
		 * Minted by the gateway when it first stores this routine and carried across every edit, so
		 * what the routine remembers survives a rename and dies with the routine. An id reused after
		 * a delete gets a new one, which is what stops a fresh routine inheriting a dead one's memory.
		 * Not the created time: two routines stored in one millisecond would share that.
		 */
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

/**
 * Secrets an occurrence asked for and never got. It says which run wanted them, so the owner can
 * approve that one or link the entry so later runs stop asking.
 */
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
		/** When it last refused a moved revision. Saving the routine again is what clears it. */
		reviewAt: z.number().int().nonnegative().optional(),
		attention: RoutineAttentionSchema.optional(),
	})
	.meta({ id: "RoutineState" });

export const ConsoleRoutineListResultSchema = z
	.object({
		routines: z.array(RoutineStateSchema),
		/**
		 * The zone this gateway reads a schedule in, so an editor showing the owner their own time
		 * has something to convert into. There is no zone picker: the gateway's zone is canonical.
		 */
		zone: z.string().min(1),
	})
	.meta({ id: "ConsoleRoutineListResult" });

export const ConsoleRoutinePutResultSchema = z
	.object({
		stored: z.boolean(),
		/** What the gateway holds after the write, so a refused put says what to reopen. */
		revision: z.number().int().nonnegative(),
		/** The stored record, so the phone adopts the revision the gateway minted. */
		routine: RoutineSchema.optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "ConsoleRoutinePutResult" });

/**
 * Null when the rule names nothing further, which a refused rule also does. Required rather than
 * optional: an all-optional answer matches anything, and the union that carries it could then no
 * longer refuse a shape nothing produces.
 */
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

/**
 * A fresh run names the occurrence it opened, since the gateway chose the instant. The id is the
 * instant as a string, as every other occurrence id on this wire is.
 */
export const ConsoleRoutineRunResultSchema = z
	.object({
		ran: z.boolean(),
		occurrenceId: z.string().min(1).max(128).optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "ConsoleRoutineRunResult" });

/**
 * What a routine's own session asks back for, and what it is answered. Session wire, not phone wire,
 * so it carries no `.meta` id and generates no Kotlin.
 */
/** The shape, so the tool's input and the route's parse are the same declaration. */
export const SessionRoutineRequestShape = {
	occurrenceId: z.string().min(1).max(64).describe(`Occurrence id from the nudge.`),
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
/** Derived, not written twice: the gateway's answer and this schema are one declaration. */
export type SessionRoutineAnswer = z.infer<typeof SessionRoutineAnswerSchema>;

/**
 * What a filed report leaves of the work window. Long enough that a session which spoke too soon can
 * still finish, short enough that a finished run stops holding its routine's secrets all day.
 */
export const ROUTINE_REPORT_GRACE_MS = 30 * 60 * 1000;

/** Bounded so a runaway session cannot write the occurrence file to the disk's end. */
export const MAX_ROUTINE_REPORT_CHARS = 16_384;

/**
 * What a routine may remember, in UTF-8 BYTES rather than characters, since the bound is on the file
 * and one character is up to four of them. Oversized is refused and never trimmed: silently cutting
 * what a session chose to carry forward loses facts nobody can see went missing.
 */
export const MAX_ROUTINE_MEMORY_BYTES = 32_768;

export const SessionReportRequestShape = {
	occurrenceId: z.string().min(1).max(64).describe(`Occurrence id from the nudge.`),
	report: z
		.string()
		.min(1)
		.max(MAX_ROUTINE_REPORT_CHARS)
		.describe(`What the run did and what it left, in the run's own words.`),
	history: z
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
	/** The run is over, by deadline or by the session having gone quiet. Nothing left to narrow. */
	z.object({ kind: z.literal("not_working") }),
	/**
	 * Another run wrote history since this one read it. Carries what is held now so the session can
	 * consolidate and file again. Bounces exactly once: the next filing is taken as it stands.
	 */
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

/**
 * Why a routine cannot be stored, or null. Bounds nothing by size; a record is refused for what it
 * means, as a runbook is.
 */
export function routineRefusal(routine: Routine): string | null {
	if (routine.weekdays.length === 0) return "a routine with no weekday would never fire";
	if (new Set(routine.weekdays).size !== routine.weekdays.length) return "a weekday is named twice";
	if (new Set(routine.linkedEntries).size !== routine.linkedEntries.length) return "a secret is linked twice";
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
