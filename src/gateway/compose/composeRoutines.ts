import type { Ambient } from "../../shared/ambient.js";
import { openDurable } from "../../shared/durable-store.js";
import type { RoutineMiss, RoutineState } from "../../shared/schemasRoutine.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import type { RoutineConsoleHandlers } from "../console/consoleTypes.js";
import { createOccurrenceStore, type Occurrence } from "../routines/occurrences.js";
import { createRoutineRunner, type RoutineAttempt } from "../routines/runner.js";
import { createRoutineStore } from "../routines/store.js";

export interface RoutineStageDeps {
	dataDir: string;
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	/** Execution arrives in its own phase; until then nothing prepares and nothing is delivered. */
	attempt?: RoutineAttempt;
	getRunbook?: (runbookId: string) => Runbook | null;
	knowsSpawn?: (spawn: string) => boolean;
}

export interface RoutineStage {
	console: RoutineConsoleHandlers;
	/** Armed from federation activation, so it cannot fire before the routes exist. */
	start: () => void;
	stop: () => Promise<void>;
	reconcile: () => Promise<void>;
}

/** Nothing to run against, so every occurrence waits rather than being declared missed. */
const IDLE_ATTEMPT: RoutineAttempt = {
	sessionIdle: () => false,
	prepare: async () => null,
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
	const store = openDurable(deps.dataDir, "routines", (durable) =>
		createRoutineStore({
			store: durable,
			getRunbook: deps.getRunbook,
			knowsSpawn: deps.knowsSpawn,
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
		attempt: deps.attempt ?? IDLE_ATTEMPT,
	});

	const state = (): RoutineState[] => {
		const now = deps.ambient.now();
		return store.list().map((routine) => {
			const rows = occurrences.forRoutine(routine.id);
			const ran = rows
				.filter((row) => row.state === "dispatched")
				.sort((a, b) => b.scheduledAt - a.scheduledAt)[0];
			const nextAt = runner.nextAt(routine, now);
			return {
				routine,
				...(nextAt === null ? {} : { nextAt }),
				...(ran ? { lastRanAt: ran.scheduledAt } : {}),
				...(panelFor(rows, now) ? { missed: panelFor(rows, now) } : {}),
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
				occurrences.clear(routineId);
				return store.remove(routineId);
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
	};
}
