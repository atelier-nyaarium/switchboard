// A routine is a schedule the gateway runs, bound to a runbook the owner already approved.

import { z } from "zod";
import { instantOf, type LocalDate, nextOccurrence, parseLocalDate, parseLocalTime } from "./routine-recurrence.js";

/** A fortnight is the longest interval the editor offers. */
const MAX_WEEK_INTERVAL = 8;

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
		id: z.string().min(1),
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
		enabled: z.boolean(),
		/** Bumped by the gateway on every save, so a stale editor cannot land on a moved record. */
		revision: z.number().int().positive(),
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

/** What the phone draws a row from. It recomputes no instant of its own. */
export const RoutineStateSchema = z
	.object({
		routine: RoutineSchema,
		/** Absent when disabled, or when the rule names nothing further. */
		nextAt: z.number().int().nonnegative().optional(),
		lastRanAt: z.number().int().nonnegative().optional(),
		missed: RoutineMissSchema.optional(),
	})
	.meta({ id: "RoutineState" });

export const ConsoleRoutineListResultSchema = z
	.object({ routines: z.array(RoutineStateSchema) })
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

export type RoutineMiss = z.infer<typeof RoutineMissSchema>;
export type RoutineState = z.infer<typeof RoutineStateSchema>;
export type ConsoleRoutineListResult = z.infer<typeof ConsoleRoutineListResultSchema>;
export type ConsoleRoutinePutResult = z.infer<typeof ConsoleRoutinePutResultSchema>;
export type ConsoleRoutineDeleteResult = z.infer<typeof ConsoleRoutineDeleteResultSchema>;
export type ConsoleRoutineOccurrenceResult = z.infer<typeof ConsoleRoutineOccurrenceResultSchema>;

/**
 * Why a routine cannot be stored, or null. Bounds nothing by size; a record is refused for what it
 * means, as a runbook is.
 */
export function routineRefusal(routine: Routine): string | null {
	if (routine.weekdays.length === 0) return "a routine with no weekday would never fire";
	if (new Set(routine.weekdays).size !== routine.weekdays.length) return "a weekday is named twice";
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
