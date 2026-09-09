import type { Ambient } from "../../shared/ambient.js";
import { openDurable } from "../../shared/durable-store.js";
import type { Routine, RoutineAttention, RoutineMiss, RoutineState } from "../../shared/schemasRoutine.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import type { RoutineConsoleHandlers } from "../console/consoleTypes.js";
import { type Attention, createAttentionStore } from "../routines/attention.js";
import { createOccurrenceStore, type Occurrence, occurrenceId } from "../routines/occurrences.js";
import { createRoutineRunner, type RoutineAttempt } from "../routines/runner.js";
import { createRoutineStore } from "../routines/store.js";

export interface RoutineStageDeps {
	dataDir: string;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	/** Read late, since what executes is composed after this stage. */
	attempt?: () => RoutineAttempt | null;
	getRunbook?: (runbookId: string) => Runbook | null;
	knowsSpawn?: (spawn: string) => boolean;
	sessionTaken?: (routine: Routine) => boolean;
	/** Makes a routine's grants match the entries it links, and is the only road to one. */
	setRoutineGrants?: (routineId: string, entryIds: string[]) => void;
}

export interface RoutineStage {
	console: RoutineConsoleHandlers;
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
}

/** Nothing to run against, so every occurrence waits rather than being declared missed. */
const IDLE_ATTEMPT: RoutineAttempt = {
	sessionIdle: () => false,
	prepare: async () => ({ ok: false, reason: "unreachable" }),
	deliver: async () => undefined,
};

/** The newest occurrence that wanted something, folded into one line for the phone. */
function attentionFor(rows: Attention[]): RoutineAttention | undefined {
	const newest = rows.reduce((held, row) => Math.max(held, row.scheduledAt), -1);
	if (newest < 0) return undefined;
	const wanted = rows.filter((row) => row.scheduledAt === newest);
	return {
		occurrenceId: occurrenceId(wanted[0]!.routineId, newest),
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
	const store = openDurable(deps.dataDir, "routines", (durable) =>
		createRoutineStore({
			store: durable,
			getRunbook: deps.getRunbook,
			knowsSpawn: deps.knowsSpawn,
			sessionTaken: deps.sessionTaken,
			now: () => deps.ambient.now(),
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

	/** Every routine pinned to that runbook, since one whose pin moved stops running. */
	const runbookMoved = (runbookId: string): void => {
		for (const routine of store.list()) {
			if (routine.runbookId === runbookId) settleGrants(routine.id);
		}
	};

	return {
		console: {
			list: () => ({ routines: state() }),
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
			remove: (routineId) => {
				// The routine goes first, so a half-done delete leaves rows nothing will walk.
				const removed = store.remove(routineId);
				occurrences.clear(routineId);
				attention.clear(routineId);
				if (removed.deleted) settleGrants(routineId);
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
		workingRoutine: (sessionTarget) => runner.workingOccurrence(sessionTarget)?.routineId ?? null,
		runbookMoved,
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
