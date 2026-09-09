import type { Ambient } from "../../shared/ambient.js";
import { openDurable } from "../../shared/durable-store.js";
import {
	type Routine,
	type RoutineAttention,
	type RoutineMiss,
	type RoutineState,
	routineRefusal,
} from "../../shared/schemasRoutine.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import type { RoutineConsoleHandlers } from "../console/consoleTypes.js";
import { fireAndForget } from "../fireAndForget.js";
import { type Attention, createAttentionStore } from "../routines/attention.js";
import { createOccurrenceStore, type Occurrence } from "../routines/occurrences.js";
import { routineTeam } from "../routines/reservation.js";
import { createRoutineRoutes, type Handler as RoutineRouteHandler } from "../routines/routineRoutes.js";
import { createRoutineRunner, type RoutineAttempt } from "../routines/runner.js";
import { createRoutineStore } from "../routines/store.js";

export interface RoutineStageDeps {
	dataDir: string;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	/** Read late, since what executes is composed after this stage. */
	attempt?: () => RoutineAttempt | null;
	getRunbook?: (runbookId: string) => Runbook | null;
	knowsSpawn?: (spawn: string) => boolean;
	/**
	 * Whether that session is this routine's own, asked by provenance rather than by its name. The
	 * one provenance question, asked when a routine is saved, when it reserves, and when its
	 * authority is read.
	 */
	sessionOwned?: (team: string, routine: Routine) => boolean;
	/** Makes a routine's grants match the entries it links, and is the only road to one. */
	setRoutineGrants?: (routineId: string, entryIds: string[]) => void;
	/**
	 * The team a session's own token resolves to, which is who may read a snapshot. Required: an
	 * omitted one leaves the door permanently answering unauthenticated, and typechecks.
	 */
	resolveCaller: (req: Request) => string | null;
}

export interface RoutineStage {
	console: RoutineConsoleHandlers;
	/** The loopback door a routine's own session reads its instructions through. */
	routes: Map<string, RoutineRouteHandler>;
	/** Armed from federation activation, so it cannot fire before the routes exist. */
	start: () => void;
	stop: () => Promise<void>;
	reconcile: () => Promise<void>;
	bindExecution: (attempt: RoutineAttempt) => void;
	/** The routine whose work is open in that session, which is what a standing grant reads. */
	workingRoutine: (sessionTarget: string) => string | null;
	/** A runbook moved or went, so every routine pinned to it settles its grants again. */
	runbookMoved: (runbookId: string) => void;
	/** A secret the owner never answered for, recorded against the occurrence that wanted it. */
	secretUnanswered: (sessionTarget: string, entryId: string) => void;
	/** That session is closed or forgotten, so any work open in it is over. */
	sessionEnded: (sessionTarget: string) => void;
}

/** Nothing to run against, so every occurrence waits rather than being declared missed. */
const IDLE_ATTEMPT: RoutineAttempt = {
	sessionIdle: () => false,
	prepare: async () => ({ ok: false, reason: "unreachable" }),
	deliver: async () => undefined,
};

/**
 * The zone this gateway reads a schedule in. Its own, from the container, so the canonical zone is
 * a real one that observes daylight saving rather than a line in a Dockerfile.
 */
function gatewayZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The newest occurrence that wanted something, folded into one line for the phone. */
function attentionFor(rows: Attention[]): RoutineAttention | undefined {
	const newest = rows.reduce((held, row) => Math.max(held, row.scheduledAt), -1);
	if (newest < 0) return undefined;
	const wanted = rows.filter((row) => row.scheduledAt === newest);
	return {
		// The instant, as the miss panel names it. Run now and Dismiss read this as a number.
		occurrenceId: String(newest),
		scheduledAt: newest,
		entryIds: [...new Set(wanted.map((row) => row.entryId))].sort(),
	};
}

function panelFor(rows: Occurrence[], now: number): RoutineMiss | undefined {
	const missed = rows.filter((row) => row.state === "missed").sort((a, b) => b.scheduledAt - a.scheduledAt);
	const newest = missed[0];
	if (!newest) return undefined;
	return {
		occurrenceId: String(newest.scheduledAt),
		scheduledAt: newest.scheduledAt,
		reason: newest.reason ?? "gateway_down",
		runnable: now <= newest.deadlineAt,
	};
}

export function composeRoutines(deps: RoutineStageDeps): RoutineStage {
	let bound: RoutineAttempt | null = null;
	/** Nobody to ask answers true, which is what the store's own tests stand on. */
	const ownsIts = (team: string, routine: Routine): boolean => deps.sessionOwned?.(team, routine) ?? true;
	const store = openDurable(deps.dataDir, "routines", (durable) =>
		createRoutineStore({
			store: durable,
			getRunbook: deps.getRunbook,
			knowsSpawn: deps.knowsSpawn,
			sessionTaken: (routine) => ownsIts(routineTeam(routine), routine) === false,
			now: () => deps.ambient.now(),
			onChanged: () => storeMoved(),
		}),
	);
	const occurrences = openDurable(deps.dataDir, "routine-occurrences", (durable) =>
		createOccurrenceStore({ store: durable }),
	);
	const attention = openDurable(deps.dataDir, "routine-attention", (durable) =>
		createAttentionStore({ store: durable }),
	);
	const runner = createRoutineRunner({
		routines: store,
		occurrences,
		ambient: deps.ambient,
		attempt: () => bound ?? deps.attempt?.() ?? IDLE_ATTEMPT,
	});

	const state = (): RoutineState[] => {
		const now = deps.ambient.now();
		return store.list().map((routine) => {
			const rows = occurrences.forRoutine(routine.id);
			const newestOf = (state: Occurrence["state"]) =>
				rows.filter((row) => row.state === state).sort((a, b) => b.scheduledAt - a.scheduledAt)[0];
			const ran = newestOf("dispatched");
			const review = newestOf("needs_review");
			const nextAt = runner.nextAt(routine, now);
			const missed = panelFor(rows, now);
			const wanted = attentionFor(attention.forRoutine(routine.id));
			return {
				routine,
				...(nextAt === null ? {} : { nextAt }),
				...(ran ? { lastRanAt: ran.scheduledAt } : {}),
				// Whether the newest run was picked up at all, which liveness alone cannot say.
				...(ran?.readAt === undefined ? {} : { lastReadAt: ran.readAt }),
				...(missed ? { missed } : {}),
				...(review ? { reviewAt: review.scheduledAt } : {}),
				...(wanted ? { attention: wanted } : {}),
			};
		});
	};

	/** Whether the words this routine pinned are the ones stored, which is what its authority rests on. */
	const pinIsHeld = (routine: Routine): boolean =>
		deps.getRunbook === undefined || deps.getRunbook(routine.runbookId)?.revision === routine.approvedRevision;

	/**
	 * A routine's authority is exactly what its stored record links, so a save, an enable, a disable,
	 * a delete and a runbook moving past its pin all settle it by rewriting from the record. Only the
	 * owner reaches these, and nothing inside a session does.
	 */
	const settleGrants = (routineId: string): void => {
		const held = store.get(routineId);
		const authorized = held?.enabled && pinIsHeld(held) ? held.linkedEntries : [];
		deps.setRoutineGrants?.(routineId, authorized);
	};

	/**
	 * The runner wakes for what the store said when it last armed. Every write moves that, so the
	 * store publishes here: without it the reconcile tick is the only thing that ever fires a
	 * routine, and one saved a moment before its slot waits out the tick instead of running.
	 */
	function storeMoved(): void {
		fireAndForget("routine rearm", runner.reconcile());
	}

	/** Every routine pinned to that runbook, since one whose pin moved stops running. */
	const runbookMoved = (runbookId: string): void => {
		let touched = false;
		for (const routine of store.list()) {
			if (routine.runbookId !== runbookId) continue;
			settleGrants(routine.id);
			touched = true;
		}
		// A run waiting on words that just came back to its pin can be prepared now.
		if (touched) storeMoved();
	};

	return {
		routes: createRoutineRoutes({
			resolveCaller: deps.resolveCaller,
			occurrences: () => occurrences.all(),
			routineName: (routineId) => store.get(routineId)?.name ?? null,
			noteRead: (routineId, scheduledAt) => occurrences.noteRead(routineId, scheduledAt, deps.ambient.now()),
		}),
		console: {
			list: () => ({ routines: state(), zone: gatewayZone() }),
			put: (routine, base) => {
				const result = store.put(routine, { base });
				if (result.stored) {
					occurrences.clearReview(routine.id);
					// The owner has just said what this routine may reach, so what it wanted is answered.
					attention.clear(routine.id);
					settleGrants(routine.id);
				}
				return result;
			},
			nextAt: (routine) => {
				const refusal = routineRefusal(routine);
				if (refusal) return { nextAt: null, reason: refusal };
				return { nextAt: runner.nextAt(routine, deps.ambient.now()) };
			},
			remove: (routineId) => {
				// The routine goes first, so a half-done delete leaves rows nothing will walk. A
				// refused delete leaves a live routine, and its history is not this call's to take.
				const removed = store.remove(routineId);
				if (!removed.deleted) return removed;
				occurrences.clear(routineId);
				attention.clear(routineId);
				settleGrants(routineId);
				return removed;
			},
			enable: (routineId, enabled) => {
				const result = store.setEnabled(routineId, enabled);
				if (result.stored) settleGrants(routineId);
				return result;
			},
			runNow: async (routineId, occurrenceId) => {
				const ran = await runner.runNow(routineId, Number(occurrenceId));
				return ran ? { applied: true } : { applied: false, reason: "that occurrence cannot be run now" };
			},
			dismiss: (routineId, occurrenceId) =>
				runner.dismiss(routineId, Number(occurrenceId))
					? { applied: true }
					: { applied: false, reason: "that occurrence is not waiting to be dismissed" },
		},
		start: () => runner.start(),
		stop: () => runner.stop(),
		reconcile: () => runner.reconcile(),
		bindExecution: (attempt) => {
			bound = attempt;
		},
		workingRoutine: (sessionTarget) => {
			const held = runner.workingOccurrence(sessionTarget);
			const routine = held && store.get(held.routineId);
			// A session that merely took the name is not the routine's, so its authority does not
			// follow the name into it.
			if (!routine || !ownsIts(sessionTarget, routine)) return null;
			return routine.id;
		},
		runbookMoved,
		sessionEnded: (sessionTarget) => {
			// Its session is gone, so its work is over whatever the last observation said.
			const held = runner.workingOccurrence(sessionTarget);
			if (held) occurrences.noteWork(held.routineId, held.scheduledAt, "done");
		},
		secretUnanswered: (sessionTarget, entryId) => {
			const held = runner.workingOccurrence(sessionTarget);
			if (!held) return;
			attention.note({
				routineId: held.routineId,
				scheduledAt: held.scheduledAt,
				entryId,
				at: deps.ambient.now(),
			});
		},
	};
}
