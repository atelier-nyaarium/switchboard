// One loop owns an occurrence. Everything that could act on one enters through `advance`.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { chainedTimer } from "../../shared/chained-timer.js";
import { createFifo } from "../../shared/keyed-fifo.js";
import type { LaunchFailure } from "../../shared/launch-notice.js";
import type { MissReason } from "../../shared/routine-occurrence.js";
import { nextOccurrence } from "../../shared/routine-recurrence.js";
import { forgetAfterMs, type Routine } from "../../shared/schemasRoutine.js";
import { fireAndForget } from "../fireAndForget.js";
import { type Occurrence, type OccurrenceStore, pastLife, workEnded } from "./occurrences.js";
import { routineTeam, targetRules } from "./reservation.js";
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
	/** Its values do not render against the stored runbook. */
	| { ok: false; reason: "unrenderable" }
	/** Something else holds the session this routine reserves, so only the owner can settle it. */
	| { ok: false; reason: "session_taken" }
	| { ok: false; reason: "assistant_unplaced" }
	| { ok: false; reason: "launch_failed"; failure: LaunchFailure }
	/** Its session is starting; nothing relaunches it. */
	| { ok: false; reason: "launching" }
	/** Nothing is wrong with the routine; the session could not be reached. */
	| { ok: false; reason: "unreachable" };

/** The loop owns when, this owns what. */
export interface RoutineAttempt {
	/** Whether that session can take work now. */
	sessionIdle: (team: string) => boolean;
	/** Whether a record still stands for that session. */
	hasSession: (team: string) => boolean;
	/** Drops the session a finished routine reserved, the way an owner's forget would. */
	forgetSession: (team: string) => void;
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
	/** Finishes a filing whose memory write never landed. Runs before the sweep that would erase it. */
	recoverProposals?: () => void;
	/** Drops memory whose routine is gone. Absent in the store's own tests, which hold none. */
	sweepMemory?: (live: Set<string>) => void;
}

export function createRoutineRunner(deps: RoutineRunnerDeps) {
	const { routines, occurrences, ambient, recoverProposals, sweepMemory } = deps;
	const attempt = () => deps.attempt();
	let timer: TimerHandle | null = null;
	let tick: TimerHandle | null = null;
	let admitting = false;
	/** Fences queued timer callbacks. */
	let generation = 0;
	/** Serializes occurrence walks. */
	const walks = createFifo();

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

	/** The only door; no two callers walk one occurrence. */
	async function advance(occurrence: Occurrence): Promise<void> {
		const routine = routines.get(occurrence.routineId);
		if (!routine) return;
		const now = ambient.now();

		// Disable stops the schedule, not a pressed run.
		const scheduled = occurrence.adhoc !== true;

		if (now > occurrence.deadlineAt) {
			// Keeps the cause it waited on.
			miss(occurrence, occurrence.reason ?? "gateway_down");
			return;
		}
		if (scheduled && !routine.enabled) {
			miss(occurrence, "disabled");
			return;
		}

		/** Names the deadline's cause. */
		const wait = (row: Occurrence, reason: MissReason) => {
			if (row.state === "waiting_idle") {
				occurrences.noteWaiting(row.routineId, row.scheduledAt, reason);
				return;
			}
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
			if (targetRules(routine).waitsForIdle && !attempt().sessionIdle(routineTeam(routine))) {
				wait(held, "session_busy");
				return;
			}
			const prepared = await attempt().prepare(routine, held);
			if (!prepared.ok) {
				if (prepared.reason === "unreachable") {
					// Reachability may return in-window.
					wait(held, "host_unreachable");
					return;
				}
				if (prepared.reason === "launching") {
					wait(held, "session_starting");
					return;
				}
				occurrences.transition(
					held.routineId,
					held.scheduledAt,
					{ state: held.state, version: held.version },
					"needs_review",
					{
						reviewCause: prepared.reason,
						...(prepared.reason === "launch_failed" ? { launchFailure: prepared.failure } : {}),
					},
				);
				return;
			}
			const afterPrepare = routines.get(held.routineId);
			if (!afterPrepare || (scheduled && !afterPrepare.enabled)) {
				miss(held, "disabled");
				return;
			}
			// Edited mid-prepare; the next sweep re-prepares.
			if (afterPrepare.revision !== routine.revision) return;
			const moved = occurrences.transition(
				held.routineId,
				held.scheduledAt,
				{ state: held.state, version: held.version },
				"prepared",
				{
					preparedRevision: prepared.revision,
					snapshot: prepared.snapshot,
					team: prepared.team,
					incarnation: routine.incarnation,
				},
			);
			if (!moved) return;
			held = moved;
		}

		if (held.state !== "prepared") return;
		const currentRoutine = routines.get(held.routineId);
		if (!currentRoutine || (scheduled && !currentRoutine.enabled)) {
			miss(held, "disabled");
			return;
		}
		if (ambient.now() > held.deadlineAt) {
			miss(held, "gateway_down");
			return;
		}
		// Before delivery: a crash loses it, never repeats it. Opens `work`.
		const dispatched = occurrences.transition(
			held.routineId,
			held.scheduledAt,
			{ state: held.state, version: held.version },
			"dispatched",
			{ work: "open", workUntil: ambient.now() + GRACE_MS },
		);
		if (!dispatched) return;
		await attempt().deliver(routine, dispatched);
	}

	/** Idle leaves work open. Reports may shorten its deadline. */
	function noteWork(occurrence: Occurrence, now: number): void {
		if (occurrence.work === undefined || occurrence.work === "done") return;
		if (now > (occurrence.workUntil ?? occurrence.deadlineAt)) {
			occurrences.noteWork(occurrence.routineId, occurrence.scheduledAt, "done");
			return;
		}
		const team = occurrence.team;
		if (team && !attempt().sessionIdle(team))
			occurrences.noteWork(occurrence.routineId, occurrence.scheduledAt, "started");
	}

	/** Measured from the newest occurrence, since an unfiled run has no report. */
	function forgetFinishedSessions(now: number): void {
		for (const routine of routines.list()) {
			if (!targetRules(routine).ownsSession) continue;
			const team = routineTeam(routine);
			if (!attempt().hasSession(team)) continue;
			if (workingOccurrences(team).length > 0) continue;
			const rows = occurrences.forRoutine(routine.id);
			if (rows.length === 0) continue;
			const newest = Math.max(...rows.map((row) => row.scheduledAt));
			if (now - newest < forgetAfterMs(routine)) continue;
			attempt().forgetSession(team);
		}
	}

	/** Every open window; each press carries its own. */
	function workingOccurrences(sessionTarget: string): Occurrence[] {
		const now = ambient.now();
		return occurrences.all().filter((occurrence) => {
			if (occurrence.team !== sessionTarget || workEnded(occurrence)) return false;
			if (pastLife(occurrence, routines.get(occurrence.routineId)?.incarnation)) return false;
			return now <= (occurrence.workUntil ?? occurrence.deadlineAt);
		});
	}

	/** One representative; ending a session takes all. */
	function firstWorkingOccurrence(sessionTarget: string): Occurrence | null {
		return workingOccurrences(sessionTarget)[0] ?? null;
	}

	/** Collapses all missed slots into the latest. */
	function recordSevereMiss(routine: Routine, now: number): void {
		// Rule-named slots only; a pressed run would move the floor past a miss.
		const seen = occurrences.forRoutine(routine.id).filter((row) => row.adhoc !== true);
		const newest = seen.reduce((held, row) => Math.max(held, row.scheduledAt), 0);
		const closed = now - GRACE_MS;
		// Never before the routine existed.
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

	/** Opens due slots, walks them, rearms. */
	async function sweepDue(): Promise<void> {
		if (!admitting) return;
		const now = ambient.now();

		// Always rearm.
		try {
			for (const occurrence of occurrences.all()) {
				if (occurrence.state === "due" || occurrence.state === "waiting_idle") await advance(occurrence);
				else if (occurrence.state === "dispatched") noteWork(occurrence, now);
			}

			for (const routine of routines.list()) {
				if (!routine.enabled) continue;
				recordSevereMiss(routine, now);
				// In-window slots only.
				let cursor = nextAt(routine, Math.max(now - GRACE_MS, routine.since));
				while (cursor !== null && cursor <= now) {
					const opened = occurrences.open(routine.id, cursor, cursor + GRACE_MS);
					if (opened && (opened.state === "due" || opened.state === "waiting_idle")) await advance(opened);
					cursor = nextAt(routine, cursor);
				}
			}

			forgetFinishedSessions(now);
			// Before the sweep deletes proposals.
			recoverProposals?.();
			occurrences.sweep(now - KEEP_MS);
			// Collects memory a failed clear orphaned.
			sweepMemory?.(new Set(routines.list().flatMap((r) => (r.incarnation ? [r.incarnation] : []))));
		} finally {
			rearm(now);
		}
	}

	/** Earliest deadline or due instant after `from`. */
	function earliest(from: number): number | null {
		const instants: number[] = [];
		for (const occurrence of occurrences.all()) {
			if (occurrence.state === "waiting_idle") instants.push(occurrence.deadlineAt);
		}
		for (const routine of routines.list()) {
			const at = nextAt(routine, from);
			if (at !== null) instants.push(at);
		}
		return instants.length === 0 ? null : Math.min(...instants);
	}

	/** Takes the walk's clock; a fresh read could skip a slot. */
	function rearm(from: number): void {
		if (timer) ambient.clearTimer(timer);
		timer = null;
		if (!admitting) return;
		const at = earliest(from);
		if (at === null) return;
		const delay = Math.max(0, at - ambient.now());
		timer = chainedTimer(ambient, delay, () => fireAndForget("routine sweep", walks.run(sweepDue))).handle();
	}

	return {
		start(): void {
			if (admitting) return;
			admitting = true;
			const mine = ++generation;
			tick = ambient.setTimer(function again() {
				// Ignore stale callbacks.
				if (mine !== generation) return;
				fireAndForget("routine sweep", walks.run(sweepDue));
				tick = ambient.setTimer(again, RECONCILE_MS);
			}, RECONCILE_MS);
			fireAndForget("routine sweep", walks.run(sweepDue));
		},

		/** Stops admission and drains. */
		async stop(): Promise<void> {
			admitting = false;
			generation += 1;
			if (timer) ambient.clearTimer(timer);
			if (tick) ambient.clearTimer(tick);
			timer = null;
			tick = null;
			await walks.drain();
		},

		/** Console and test entry. */
		reconcile(): Promise<void> {
			return walks.run(sweepDue);
		},

		/** A waiting run's launch ended; true once taken. A version CAS fences a walk. */
		launchEnded(
			routineId: string,
			scheduledAt: number,
			outcome: { up: true } | { failure: LaunchFailure },
			team: string,
		): boolean {
			if (!admitting) return false;
			const held = occurrences.at(routineId, scheduledAt);
			if (!held || (held.state !== "due" && held.state !== "waiting_idle")) return true;
			// A retargeted run ignores its old team's launch.
			const routine = routines.get(routineId);
			if (!routine || routineTeam(routine) !== team) return true;
			if ("up" in outcome) {
				fireAndForget("routine launch up", walks.run(sweepDue));
				return true;
			}
			const moved = occurrences.transition(
				routineId,
				scheduledAt,
				{ state: held.state, version: held.version },
				"needs_review",
				{ reviewCause: "launch_failed", launchFailure: outcome.failure },
			);
			return moved !== null;
		},

		/** Its own occurrence: re-entering a rule's would break at-most-once. */
		async runFresh(routineId: string): Promise<number | null> {
			let opened: number | null = null;
			await walks.run(async () => {
				// Closed admission would write after the flush.
				if (!admitting) return;
				if (!routines.get(routineId)) return;
				const at = ambient.now();
				const made = occurrences.open(routineId, at, at + GRACE_MS, true);
				// `open` may return the rule's row, which skips scheduled gates.
				if (made?.adhoc !== true || made.state !== "due") return;
				await advance(made);
				// A waiting run's deadline is a new wake.
				rearm(at);
				// Preparation is awaited; a deadline can settle it first.
				const settled = occurrences.at(routineId, at)?.state;
				if (settled !== "missed" && settled !== "needs_review") opened = at;
			});
			return opened;
		},

		/** Reruns a missed slot with fresh authorization. */
		async runNow(routineId: string, scheduledAt: number): Promise<boolean> {
			let ran = false;
			await walks.run(async () => {
				// Closed admission would write after the flush.
				if (!admitting) return;
				const routine = routines.get(routineId);
				const held = occurrences.at(routineId, scheduledAt);
				if (!routine || !held || held.state !== "missed") return;
				const prepared = await attempt().prepare(routine, held);
				if (!prepared.ok) return;
				// Edited mid-prepare.
				if (routines.get(routineId)?.revision !== routine.revision) return;
				const dispatched = occurrences.transition(
					routineId,
					scheduledAt,
					{ state: held.state, version: held.version },
					"dispatched",
					// `work` opens here too.
					{
						preparedRevision: prepared.revision,
						snapshot: prepared.snapshot,
						team: prepared.team,
						incarnation: routine.incarnation,
						work: "open",
						workUntil: ambient.now() + GRACE_MS,
					},
				);
				if (!dispatched) return;
				await attempt().deliver(routine, dispatched);
				ran = true;
			});
			return ran;
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
		firstWorkingOccurrence,
		workingOccurrences,
	};
}

export type RoutineRunner = ReturnType<typeof createRoutineRunner>;
