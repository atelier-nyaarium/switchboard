// What a routine does when its moment comes. The runner owns when; none of that is decided here.

import { renderRunbook } from "../../shared/runbook-grammar.js";
import { type Routine, routineSessionName } from "../../shared/schemasRoutine.js";
import { type Runbook, runbookRefusal } from "../../shared/schemasRunbook.js";
import { type Occurrence, occurrenceId } from "./occurrences.js";
import { type ReserveResult, routineTeam } from "./reservation.js";
import type { PrepareResult, RoutineAttempt } from "./runner.js";

export interface RoutineExecutionDeps {
	getRunbook: (runbookId: string) => Runbook | null;
	/** True while the session is working, false while it is not, undefined when nobody knows. */
	workingOf: (team: string) => boolean | undefined;
	reserveSession: (routine: Routine) => Promise<ReserveResult>;
	/** Why the nudge was refused, or null. */
	deliver: (nudge: { from: string; to: string; body: string; deliveryId: string }) => Promise<string | null>;
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
	return {
		sessionIdle(team: string): boolean {
			// Unknown counts as idle: a session nobody has heard from is not one that is busy, and
			// the deadline is what stops this waiting forever.
			return deps.workingOf(team) !== true;
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

			// One routine's dead machine must not end the sweep.
			const reserved = await deps.reserveSession(routine).catch((): ReserveResult => ({ kind: "pending" }));
			if (reserved.kind === "taken") return { ok: false, reason: "session_taken" };
			if (reserved.kind === "pending") return { ok: false, reason: "unreachable" };
			return { ok: true, revision: runbook.revision, snapshot: rendered.text, team: reserved.team };
		},

		async deliver(routine: Routine, occurrence: Occurrence): Promise<void> {
			const team = occurrence.team ?? routineTeam(routine);
			const refused = await deps
				.deliver({
					// Display only; it sends as the owner.
					from: routineSessionName(routine.id),
					to: team,
					body: nudgeFor(routine, occurrence),
					// Names the row, and never the guarantee, which the occurrence state holds.
					deliveryId: occurrenceId(occurrence.routineId, occurrence.scheduledAt),
				})
				.catch((error: Error) => error.message);
			// Dispatched either way, so this is the only account.
			if (refused) console.warn(`[routine] ${routine.id} nudge to ${team} was not delivered: ${refused}`);
		},
	};
}
