// What a routine does when due; the runner owns when.

import { occurrenceIdOf, type Routine, routineSessionName } from "../../shared/schemasRoutine.js";
import type { Runbook } from "../../shared/schemasRunbook.js";
import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import { deliveryKey, type Occurrence } from "./occurrences.js";
import { renderRoutine } from "./render.js";
import { type ReserveResult, routineTeam, type TargetReserve, targetRules } from "./reservation.js";
import type { PrepareResult, RoutineAttempt } from "./runner.js";

export interface RoutineExecutionDeps extends TargetReserve {
	getRunbook: (runbookId: string) => Runbook | null;
	/** Undefined when unknown. */
	busyOf: (team: string) => boolean | undefined;
	hasSession: (team: string) => boolean;
	/** Same as an owner's forget. */
	forgetSession: (team: string) => void;
	holdLine?: () => string;
	/** Refusal reason, or null. */
	deliver: (nudge: { from: string; to: string; body: string; deliveryId: string }) => Promise<string | null>;
}

export function nudgeFor(routine: Routine, occurrence: Occurrence, holdLine?: string): string {
	return [
		...(routine.target.kind === "assistant" && holdLine ? [holdLine] : []),
		`Owner issued a routine: ${routine.name}.`,
		`Call ${SESSION_COMMANDS.sessionRoutine.tool} with occurrenceId "${occurrenceIdOf(occurrence.routineId, occurrence.scheduledAt)}" for the instructions.`,
		// Unfiled runs retain authority.
		`When the work is done, call ${SESSION_COMMANDS.sessionReport.tool} with the same occurrenceId.`,
		"If any blocker occurs, channel_reply.",
	].join("\n");
}

export function createRoutineExecution(deps: RoutineExecutionDeps): RoutineAttempt {
	return {
		sessionIdle(team: string): boolean {
			// Unknown counts as idle; the deadline bounds waiting.
			return deps.busyOf(team) !== true;
		},

		hasSession: deps.hasSession,

		forgetSession: deps.forgetSession,

		async prepare(routine: Routine, occurrence: Occurrence): Promise<PrepareResult> {
			const rendered = renderRoutine(deps.getRunbook(routine.runbookId), routine);
			if (!rendered.ok) return { ok: false, reason: "unrenderable" };

			// A dead host must not end the sweep.
			const reserved = await targetRules(routine)
				.reserve(routine, deps, { routineId: occurrence.routineId, scheduledAt: occurrence.scheduledAt })
				.catch((): ReserveResult => ({ kind: "pending" }));
			if (reserved.kind === "taken") return { ok: false, reason: "session_taken" };
			if (reserved.kind === "unplaced") return { ok: false, reason: "assistant_unplaced" };
			if (reserved.kind === "pending") return { ok: false, reason: "unreachable" };
			if (reserved.kind === "launching") return { ok: false, reason: "launching" };
			if (reserved.kind === "launch_failed")
				return { ok: false, reason: "launch_failed", failure: reserved.failure };
			return { ok: true, revision: rendered.revision, snapshot: rendered.text, team: reserved.team };
		},

		async deliver(routine: Routine, occurrence: Occurrence): Promise<void> {
			const team = occurrence.team ?? routineTeam(routine);
			const refused = await deps
				.deliver({
					// Display identity only.
					from: routineSessionName(routine.id),
					to: team,
					body: nudgeFor(routine, occurrence, deps.holdLine?.()),
					// Occurrence state owns guarantees.
					deliveryId: deliveryKey(occurrence.routineId, occurrence.scheduledAt),
				})
				.catch((error: Error) => error.message);
			if (refused) console.warn(`[routine] ${routine.id} nudge to ${team} was not delivered: ${refused}`);
		},
	};
}
