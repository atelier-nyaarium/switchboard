// What a routine does when its moment comes. The runner owns when; none of that is decided here.

import { renderRunbook } from "../../shared/runbook-grammar.js";
import type { Routine } from "../../shared/schemasRoutine.js";
import { type Runbook, runbookRefusal } from "../../shared/schemasRunbook.js";
import type { Occurrence } from "./occurrences.js";
import type { PrepareResult, RoutineAttempt } from "./runner.js";

export interface RoutineExecutionDeps {
	getRunbook: (runbookId: string) => Runbook | null;
	/** True while the session is working, false while it is not, undefined when nobody knows. */
	workingOf: (team: string) => boolean | undefined;
	/** Makes the reserved session if it has gone, answering the team it lives at. */
	reserveSession: (routine: Routine) => Promise<string | null>;
	/** Hands the nudge to delivery. The occurrence is already durable as dispatched. */
	deliver: (team: string, body: string) => Promise<void>;
}

/**
 * The words a routine's session is nudged with. The instructions are not inlined, because a
 * compaction would take them with it and the tool can be asked again.
 */
export function nudgeFor(routine: Routine, occurrence: Occurrence): string {
	return [
		`Owner issued a routine: ${routine.name}.`,
		`Call get_session_routine with occurrenceId "${occurrence.scheduledAt}" for the instructions.`,
		"If any blocker occurs, channel_reply.",
	].join("\n");
}

export function createRoutineExecution(deps: RoutineExecutionDeps): RoutineAttempt {
	/** Where a routine's own session lives. Derived, so no stale id is ever stored. */
	const teamOf = (routine: Routine) => `${routine.target.spawn}.routine-${routine.id}`;

	return {
		sessionIdle(routine: Routine): boolean {
			// Unknown counts as idle: a session nobody has heard from is not one that is busy, and
			// the deadline is what stops this waiting forever.
			return deps.workingOf(teamOf(routine)) !== true;
		},

		async prepare(routine: Routine, _occurrence: Occurrence): Promise<PrepareResult> {
			const runbook = deps.getRunbook(routine.runbookId);
			if (!runbook || runbook.revision !== routine.approvedRevision) {
				return { ok: false, reason: "revision_moved" };
			}
			// A stored record is checked again, so a rule it no longer passes reaches the owner.
			if (runbookRefusal(runbook)) return { ok: false, reason: "revision_moved" };

			const rendered = renderRunbook(runbook.body, runbook.parameters, routine.values);
			if (!rendered.ok) return { ok: false, reason: "revision_moved" };

			const team = await deps.reserveSession(routine);
			if (!team) return { ok: false, reason: "unreachable" };
			return { ok: true, revision: runbook.revision, snapshot: rendered.text, team };
		},

		async deliver(routine: Routine, occurrence: Occurrence): Promise<void> {
			const team = occurrence.team ?? teamOf(routine);
			await deps.deliver(team, nudgeFor(routine, occurrence));
		},
	};
}
