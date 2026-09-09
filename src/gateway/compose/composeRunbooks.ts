import { openDurable } from "../../shared/durable-store.js";
import type { RunbookConsoleHandlers } from "../console/consoleTypes.js";
import { createRunbookStore } from "../runbooks/store.js";

export interface RunbookStageDeps {
	dataDir: string;
	/** A stored runbook moved or went, which is what stops a routine pinned to an older revision. */
	onRunbookMoved?: (runbookId: string) => void;
}

export interface RunbookStage {
	console: RunbookConsoleHandlers;
}

export function composeRunbooks(deps: RunbookStageDeps): RunbookStage {
	const store = openDurable(deps.dataDir, "runbooks", (durable) => createRunbookStore({ store: durable }));
	return {
		console: {
			get: (runbookId) => store.get(runbookId),
			list: () => ({ runbooks: store.list() }),
			put: (runbook, options) => {
				const result = store.put(runbook, options);
				if (result.stored) deps.onRunbookMoved?.(runbook.id);
				return result;
			},
			remove: (runbookId) => {
				const result = store.remove(runbookId);
				if (result.deleted) deps.onRunbookMoved?.(runbookId);
				return result;
			},
		},
	};
}
