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

/** Why an occurrence could not be prepared, which decides where it goes rather than the loop. */
export type PrepareResult =
	| { ok: true; revision: number; snapshot: string; team: string }
	/** The words the owner approved are not what would run. */
	| { ok: false; reason: "revision_moved" }
	/** Something else holds the session this routine reserves, so only the owner can settle it. */
	| { ok: false; reason: "session_taken" }
	/** Nothing is wrong with the routine; the session could not be reached. */
	| { ok: false; reason: "unreachable" };

/** The loop owns when, this owns what. */
export interface RoutineAttempt {
	/** Whether the routine's reserved session can take work now. */
	sessionIdle: (routine: Routine) => boolean;
	/** Renders and binds the session, answering what to store against the occurrence. */
	prepare: (routine: Routine, occurrence: Occurrence) => Promise<PrepareResult>;
	/** Called after `dispatched` is durable, so a crash here loses the nudge rather than repeating it. */
	deliver: (routine: Routine, occurrence: Occurrence) => Promise<void>;
}

export interface RoutineRunnerDeps {
	routines: RoutineStore;
	occurrences: OccurrenceStore;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	/** Read late, because what executes is composed after the stage that runs it. */
	attempt: () => RoutineAttempt;
}

export function createRoutineRunner(deps: RoutineRunnerDeps) {
	const { routines, occurrences, ambient } = deps;
	const attempt = () => deps.attempt();
	let timer: TimerHandle | null = null;
	let tick: TimerHandle | null = null;
	let admitting = false;
	/** Fences a timer callback that was already queued when the runner stopped. */
	let generation = 0;
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
			// The cause it started waiting for; nothing probes a host this late.
			miss(occurrence, occurrence.reason ?? "gateway_down");
			return;
		}
		if (!routine.enabled) {
			miss(occurrence, "disabled");
			return;
		}

		/** Waits, naming the cause the deadline will use. */
		const wait = (row: Occurrence, reason: MissReason) => {
			if (row.state !== "due") return;
			occurrences.transition(
				row.routineId,
				row.scheduledAt,
				{ state: row.state, version: row.version },
				"waiting_idle",
				{ reason },
			);
		};

		let held = occurrence;
		if (held.state === "due" || held.state === "waiting_idle") {
			if (!attempt().sessionIdle(routine)) {
				wait(held, "session_busy");
				return;
			}
			const prepared = await attempt().prepare(routine, held);
			if (!prepared.ok) {
				if (prepared.reason === "unreachable") {
					// Reachability can come back inside the window, so this waits rather than settling.
					wait(held, "host_unreachable");
					return;
				}
				occurrences.transition(
					held.routineId,
					held.scheduledAt,
					{ state: held.state, version: held.version },
					"needs_review",
				);
				return;
			}
			const afterPrepare = routines.get(held.routineId);
			if (!afterPrepare?.enabled) {
				miss(held, "disabled");
				return;
			}
			// An edit landed while this prepared, so the snapshot is of words the owner has replaced.
			// Left where it is, for the next sweep to prepare against what they now mean.
			if (afterPrepare.revision !== routine.revision) return;
			const moved = occurrences.transition(
				held.routineId,
				held.scheduledAt,
				{ state: held.state, version: held.version },
				"prepared",
				{ preparedRevision: prepared.revision, snapshot: prepared.snapshot, team: prepared.team },
			);
			if (!moved) return;
			held = moved;
		}

		if (held.state !== "prepared") return;
		const currentRoutine = routines.get(held.routineId);
		if (!currentRoutine?.enabled) {
			miss(held, "disabled");
			return;
		}
		if (ambient.now() > held.deadlineAt) {
			miss(held, "gateway_down");
			return;
		}
		// Written before the nudge is handed over, so a crash loses it rather than sending it twice.
		const dispatched = occurrences.transition(
			held.routineId,
			held.scheduledAt,
			{ state: held.state, version: held.version },
			"dispatched",
		);
		if (!dispatched) return;
		await attempt().deliver(routine, dispatched);
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
		// Never past the moment this gateway took the routine, or a routine saved today would be
		// handed a miss for a slot that passed before it existed.
		let cursor = nextAt(routine, Math.max(newest, routine.since, now - KEEP_MS));
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

		// Rearmed whatever happened, or nothing wakes.
		try {
			for (const occurrence of occurrences.all()) {
				if (occurrence.state === "due" || occurrence.state === "waiting_idle") await advance(occurrence);
			}

			for (const routine of routines.list()) {
				if (!routine.enabled) continue;
				recordSevereMiss(routine, now);
				// Everything still inside its window, and never before the routine existed.
				let cursor = nextAt(routine, Math.max(now - GRACE_MS, routine.since));
				while (cursor !== null && cursor <= now) {
					const opened = occurrences.open(routine.id, cursor, cursor + GRACE_MS);
					if (opened && (opened.state === "due" || opened.state === "waiting_idle")) await advance(opened);
					cursor = nextAt(routine, cursor);
				}
			}

			occurrences.sweep(now - KEEP_MS);
		} finally {
			rearm();
		}
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
			const mine = ++generation;
			tick = ambient.setTimer(function again() {
				// A callback already queued when stop ran would otherwise re-arm the tick it cleared.
				if (mine !== generation) return;
				fireAndForget("routine sweep", queue(sweepDue));
				tick = ambient.setTimer(again, RECONCILE_MS);
			}, RECONCILE_MS);
			fireAndForget("routine sweep", queue(sweepDue));
		},

		/** Stops taking work, then waits for the attempt in flight. */
		async stop(): Promise<void> {
			admitting = false;
			generation += 1;
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
				// A shutdown has closed admission, and this would write after the flush.
				if (!admitting) return;
				const routine = routines.get(routineId);
				const held = occurrences.at(routineId, scheduledAt);
				if (!routine || !held || held.state !== "missed") return;
				const prepared = await attempt().prepare(routine, held);
				if (!prepared.ok) return;
				// The owner edited it while this prepared, so their Run now was for other words.
				if (routines.get(routineId)?.revision !== routine.revision) return;
				const dispatched = occurrences.transition(
					routineId,
					scheduledAt,
					{ state: held.state, version: held.version },
					"dispatched",
					{ preparedRevision: prepared.revision, snapshot: prepared.snapshot, team: prepared.team },
				);
				if (!dispatched) return;
				await attempt().deliver(routine, dispatched);
				ran = true;
			}).then(() => ran);
		},

		dismiss(routineId: string, scheduledAt: number): boolean {
			if (!admitting) return false;
			const held = occurrences.at(routineId, scheduledAt);
			if (held?.state !== "missed") return false;
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
