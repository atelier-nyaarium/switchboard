import type { Ambient } from "../../shared/ambient.js";
import { openDurable } from "../../shared/durable-store.js";
import type { Routine, RoutineMiss, RoutineState } from "../../shared/schemasRoutine.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import type { RoutineConsoleHandlers } from "../console/consoleTypes.js";
import { createOccurrenceStore, type Occurrence } from "../routines/occurrences.js";
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
}

export interface RoutineStage {
	console: RoutineConsoleHandlers;
	/** Armed from federation activation, so it cannot fire before the routes exist. */
	start: () => void;
	stop: () => Promise<void>;
	reconcile: () => Promise<void>;
	bindExecution: (attempt: RoutineAttempt) => void;
}

/** Nothing to run against, so every occurrence waits rather than being declared missed. */
const IDLE_ATTEMPT: RoutineAttempt = {
	sessionIdle: () => false,
	prepare: async () => ({ ok: false, reason: "unreachable" }),
	deliver: async () => undefined,
};

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
			return {
				routine,
				...(nextAt === null ? {} : { nextAt }),
				...(ran ? { lastRanAt: ran.scheduledAt } : {}),
				...(missed ? { missed } : {}),
				...(review ? { reviewAt: review.scheduledAt } : {}),
			};
		});
	};

	return {
		console: {
			list: () => ({ routines: state() }),
			put: (routine, base) => {
				const result = store.put(routine, { base });
				if (result.stored) occurrences.clearReview(routine.id);
				return result;
			},
			remove: (routineId) => {
				// The routine goes first, so a half-done delete leaves rows nothing will walk.
				const removed = store.remove(routineId);
				occurrences.clear(routineId);
				return removed;
			},
			enable: (routineId, enabled) => store.setEnabled(routineId, enabled),
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
	};
}
