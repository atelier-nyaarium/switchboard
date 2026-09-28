// A routine runs whatever revision of its runbook is stored now.

import { renderRunbook } from "../../shared/runbook-grammar.js";
import type { Routine } from "../../shared/schemasRoutine.js";
import { type Runbook, runbookRefusal } from "../../shared/schemasRunbook.js";

export type RoutineRender = { ok: true; text: string; revision: number } | { ok: false; reason: string };

/** The one reading of whether a routine can run. */
export function renderRoutine(runbook: Runbook | null | undefined, routine: Routine): RoutineRender {
	if (!runbook) return { ok: false, reason: `no runbook called ${routine.runbookId} is stored here` };
	const refusal = runbookRefusal(runbook);
	if (refusal) return { ok: false, reason: refusal };
	const declared = new Set(runbook.parameters.map((parameter) => parameter.name));
	// Unused, not wrong.
	const values = Object.fromEntries(Object.entries(routine.values).filter(([name]) => declared.has(name)));
	const rendered = renderRunbook(runbook.body, runbook.parameters, values);
	return rendered.ok ? { ...rendered, revision: runbook.revision } : rendered;
}
