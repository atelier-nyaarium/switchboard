import { openDurable } from "../../shared/durable-store.js";
import type { RoutineConsoleHandlers } from "../console/consoleTypes.js";
import { createRoutineStore } from "../routines/store.js";

export interface RoutineStageDeps {
	dataDir: string;
}

export interface RoutineStage {
	console: RoutineConsoleHandlers;
}

export function composeRoutines(deps: RoutineStageDeps): RoutineStage {
	const store = openDurable(deps.dataDir, "routines", (durable) => createRoutineStore({ store: durable }));
	return {
		console: {
			list: () => ({ routines: store.list().map((routine) => ({ routine })) }),
			put: (routine, base) => store.put(routine, { base }),
			remove: (routineId) => store.remove(routineId),
			enable: (routineId, enabled) => store.setEnabled(routineId, enabled),
			// The runner arrives with the occurrences it would act on.
			runNow: async () => ({ applied: false, reason: "this Gateway is not running routines yet" }),
			dismiss: () => ({ applied: false, reason: "this Gateway is not running routines yet" }),
		},
	};
}
