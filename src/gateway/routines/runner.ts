// One loop owns an occurrence. Everything that could act on one enters through `advance`.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { chainedTimer } from "../../shared/chained-timer.js";
import type { MissReason } from "../../shared/routine-occurrence.js";
import { nextOccurrence } from "../../shared/routine-recurrence.js";
import type { Routine } from "../../shared/schemasRoutine.js";
import { fireAndForget } from "../fireAndForget.js";
import type { Occurrence, OccurrenceStore } from "./occurrences.js";
import type { RoutineStore } from "./store.js";

/** The authorization window. Half a day, and never extended by anything. */
export const GRACE_MS = 12 * 60 * 60 * 1000;

/** A clock jump forward does not wake a timer, so deadlines are compared on a tick as well. */
const RECONCILE_MS = 60_000;

/** Settled occurrences older than this are swept, except a routine's newest miss. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** What Phase 3 fills in. The loop owns when, this owns what. */
export interface RoutineAttempt {
	/** Whether the routine's reserved session can take work now. */
	sessionIdle: (routine: Routine) => boolean;
	/** Renders, stores the snapshot and binds the session. Answers the revision it prepared. */
	prepare: (routine: Routine, occurrence: Occurrence) => Promise<number | null>;
	/** Called after `dispatched` is durable, so a crash here loses the nudge rather than repeating it. */
	deliver: (routine: Routine, occurrence: Occurrence) => Promise<void>;
}

export interface RoutineRunnerDeps {
	routines: RoutineStore;
	occurrences: OccurrenceStore;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	attempt: RoutineAttempt;
}

export function createRoutineRunner(deps: RoutineRunnerDeps) {
	const { routines, occurrences, ambient, attempt } = deps;
	let timer: TimerHandle | null = null;
	let tick: TimerHandle | null = null;
	let admitting = false;
	let inFlight: Promise<void> = Promise.resolve();

	const ruleOf = (routine: Routine) => ({
		weekdays: routine.weekdays,
		weekInterval: routine.weekInterval,
		startDate: routine.startDate,
		time: routine.time,
		zone: routine.zone,
	});

	/** The next instant this routine names after now, or null when it names none. */
	const nextAt = (routine: Routine, after: number): number | null =>
		routine.enabled ? nextOccurrence(ruleOf(routine), after) : null;

	const miss = (occurrence: Occurrence, reason: MissReason) =>
		occurrences.transition(
			occurrence.routineId,
			occurrence.scheduledAt,
			{ state: occurrence.state, version: occurrence.version },
			"missed",
			{ reason },
		);

	/**
	 * Walks one occurrence as far as it can go now. Every caller enters here, so the timer, the tick
	 * and a manual Run now cannot each be walking the same occurrence.
	 */
	async function advance(occurrence: Occurrence): Promise<void> {
		const routine = routines.get(occurrence.routineId);
		if (!routine) return;
		const now = ambient.now();

		if (now > occurrence.deadlineAt) {
			miss(occurrence, occurrence.state === "waiting_idle" ? "session_busy" : "gateway_down");
			return;
		}
		if (!routine.enabled) {
			miss(occurrence, "disabled");
			return;
		}

		let held = occurrence;
		if (held.state === "due" || held.state === "waiting_idle") {
			if (!attempt.sessionIdle(routine)) {
				if (held.state === "due") {
					occurrences.transition(
						held.routineId,
						held.scheduledAt,
						{ state: held.state, version: held.version },
						"waiting_idle",
					);
				}
				return;
			}
			const prepared = await attempt.prepare(routine, held);
			if (prepared === null) {
				// The pinned revision moved, so the words the owner approved are not what would run.
				occurrences.transition(
					held.routineId,
					held.scheduledAt,
					{ state: held.state, version: held.version },
					"needs_review",
				);
				return;
			}
			const moved = occurrences.transition(
				held.routineId,
				held.scheduledAt,
				{ state: held.state, version: held.version },
				"prepared",
				{ preparedRevision: prepared },
			);
			if (!moved) return;
			held = moved;
		}

		if (held.state !== "prepared") return;
		// Written before the nudge is handed over, so a crash loses it rather than sending it twice.
		const dispatched = occurrences.transition(
			held.routineId,
			held.scheduledAt,
			{ state: held.state, version: held.version },
			"dispatched",
		);
		if (!dispatched) return;
		await attempt.deliver(routine, dispatched);
	}

	/** Serialized, so two wakeups cannot walk the same occurrence at once. */
	function queue(work: () => Promise<void>): Promise<void> {
		inFlight = inFlight.then(work, work);
		return inFlight;
	}

	/**
	 * A week away is one panel. Everything the rule named past its window collapses into the latest
	 * of them, so the owner is told the routine did not run without being told once per occurrence.
	 */
	function recordSevereMiss(routine: Routine, now: number): void {
		const seen = occurrences.forRoutine(routine.id);
		const newest = seen.reduce((held, row) => Math.max(held, row.scheduledAt), 0);
		const closed = now - GRACE_MS;
		let cursor = nextAt(routine, Math.max(newest, now - KEEP_MS));
		let latest: number | null = null;
		while (cursor !== null && cursor < closed) {
			latest = cursor;
			cursor = nextAt(routine, cursor);
		}
		if (latest === null) return;
		const opened = occurrences.open(routine.id, latest, latest + GRACE_MS);
		if (opened?.state === "due") {
			occurrences.transition(routine.id, latest, { state: opened.state, version: opened.version }, "missed", {
				reason: "gateway_down",
			});
		}
	}

	/** Materializes what is due, walks it, and rearms for whatever comes next. */
	async function sweepDue(): Promise<void> {
		if (!admitting) return;
		const now = ambient.now();

		for (const occurrence of occurrences.all()) {
			if (occurrence.state === "due" || occurrence.state === "waiting_idle") await advance(occurrence);
		}

		for (const routine of routines.list()) {
			if (!routine.enabled) continue;
			recordSevereMiss(routine, now);
			// Everything still inside its window, so a gateway briefly down still runs them.
			let cursor = nextAt(routine, now - GRACE_MS);
			while (cursor !== null && cursor <= now) {
				const opened = occurrences.open(routine.id, cursor, cursor + GRACE_MS);
				if (opened && (opened.state === "due" || opened.state === "waiting_idle")) await advance(opened);
				cursor = nextAt(routine, cursor);
			}
		}

		occurrences.sweep(now - KEEP_MS);
		rearm();
	}

	/** The earliest thing worth waking for, whether a deadline or a due instant. */
	function earliest(): number | null {
		const now = ambient.now();
		const instants: number[] = [];
		for (const occurrence of occurrences.all()) {
			if (occurrence.state === "waiting_idle") instants.push(occurrence.deadlineAt);
		}
		for (const routine of routines.list()) {
			const at = nextAt(routine, now);
			if (at !== null) instants.push(at);
		}
		return instants.length === 0 ? null : Math.min(...instants);
	}

	function rearm(): void {
		if (timer) ambient.clearTimer(timer);
		timer = null;
		if (!admitting) return;
		const at = earliest();
		if (at === null) return;
		const delay = Math.max(0, at - ambient.now());
		timer = chainedTimer(ambient, delay, () => fireAndForget("routine sweep", queue(sweepDue))).handle();
	}

	return {
		start(): void {
			if (admitting) return;
			admitting = true;
			tick = ambient.setTimer(function again() {
				fireAndForget("routine sweep", queue(sweepDue));
				tick = ambient.setTimer(again, RECONCILE_MS);
			}, RECONCILE_MS);
			fireAndForget("routine sweep", queue(sweepDue));
		},

		/** Stops taking work, then waits for the attempt in flight. */
		async stop(): Promise<void> {
			admitting = false;
			if (timer) ambient.clearTimer(timer);
			if (tick) ambient.clearTimer(tick);
			timer = null;
			tick = null;
			await inFlight.catch(() => undefined);
		},

		/** What the console's Run now and the tests reach. */
		reconcile(): Promise<void> {
			return queue(sweepDue);
		},

		/** A missed occurrence the owner asked for again, carrying a fresh authorization. */
		runNow(routineId: string, scheduledAt: number): Promise<boolean> {
			let ran = false;
			return queue(async () => {
				const routine = routines.get(routineId);
				const held = occurrences.at(routineId, scheduledAt);
				if (!routine || !held || held.state !== "missed") return;
				const prepared = await attempt.prepare(routine, held);
				if (prepared === null) return;
				const dispatched = occurrences.transition(
					routineId,
					scheduledAt,
					{ state: held.state, version: held.version },
					"dispatched",
					{ preparedRevision: prepared },
				);
				if (!dispatched) return;
				await attempt.deliver(routine, dispatched);
				ran = true;
			}).then(() => ran);
		},

		dismiss(routineId: string, scheduledAt: number): boolean {
			const held = occurrences.at(routineId, scheduledAt);
			if (!held || held.state !== "missed") return false;
			return (
				occurrences.transition(
					routineId,
					scheduledAt,
					{ state: held.state, version: held.version },
					"dismissed",
				) !== null
			);
		},

		nextAt,
	};
}

export type RoutineRunner = ReturnType<typeof createRoutineRunner>;
