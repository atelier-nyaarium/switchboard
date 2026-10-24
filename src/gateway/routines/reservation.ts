// Kind varies; session ownership follows provenance, not names.

import { ASSISTANT_SPAWN, ASSISTANT_TEAM, isAssistantRecord } from "../../shared/assistant-session.js";
import { type Routine, type RoutineTargetKind, routineSessionName, targetKind } from "../../shared/schemasRoutine.js";
import type { SessionRecord } from "../../shared/session-store.js";

const RESERVE_OP = "reserve";

/** The conversation a reserve is made under, which is the routine and nothing else. */
export function reserveConversation(routine: Routine): string {
	return `routine:${routine.id}`;
}

/** `createSession` stamps `${conversationId}:${opId}` as the record's provenance. */
export function reserveKey(routine: Routine): string {
	return `${reserveConversation(routine)}:${RESERVE_OP}`;
}

export { RESERVE_OP };

export type ReserveResult =
	| { kind: "ok"; team: string }
	/** Launching holds the occurrence until next tick. */
	| { kind: "pending" }
	| { kind: "taken" }
	| { kind: "unplaced" };

/** Gateway-owned facts validate routine targets. */
export interface TargetFacts {
	knowsSpawn?: (spawn: string) => boolean;
	sessionTaken?: (routine: Routine) => boolean;
	assistantPlaced?: () => boolean;
}

export interface TargetReserve {
	reserveSession: (routine: Routine) => Promise<ReserveResult>;
	reserveAssistant: () => Promise<ReserveResult>;
}

/** All target-specific behavior routes through these rules. */
export interface TargetRules {
	kind: RoutineTargetKind;
	team: (routine: Routine) => string;
	/** A busy session holds the run. The assistant is mid-task by nature, so a check-in does not wait. */
	waitsForIdle: boolean;
	/**
	 * The routine owns its session: reserves it from the sweeps, and forgets it after the keep
	 * period. The assistant's session is the assistant's.
	 */
	ownsSession: boolean;
	/** Its linked entries become a working run's grants. A check-in shares a session, so none. */
	holdsSecrets: boolean;
	/** Ownership follows session provenance. */
	owns: (held: SessionRecord | undefined, routine: Routine) => boolean;
	refusal: (routine: Routine, facts: TargetFacts) => string | null;
	reserve: (routine: Routine, roads: TargetReserve) => Promise<ReserveResult>;
}

const SPAWN_RULES: TargetRules = {
	kind: "spawn",
	team: (routine) => `${routine.target.spawn}.${routineSessionName(routine.id)}`,
	waitsForIdle: true,
	ownsSession: true,
	holdsSecrets: true,
	owns: (held, routine) => held === undefined || held.mintedFrom === reserveKey(routine),
	refusal: (routine, facts) => {
		if (facts.knowsSpawn && !facts.knowsSpawn(routine.target.spawn)) {
			return `this Gateway has no spawn point called ${routine.target.spawn}`;
		}
		return facts.sessionTaken?.(routine) ? takenReason(routine) : null;
	},
	reserve: (routine, roads) => roads.reserveSession(routine),
};

const ASSISTANT_RULES: TargetRules = {
	kind: "assistant",
	team: () => ASSISTANT_TEAM,
	waitsForIdle: false,
	ownsSession: false,
	holdsSecrets: false,
	owns: (held) => isAssistantRecord(held),
	refusal: (routine, facts) => {
		if (routine.target.spawn !== ASSISTANT_SPAWN) return "a check-in runs where the assistant lives";
		if (routine.target.workdir !== undefined) return "a check-in runs in the assistant's own folder";
		return facts.assistantPlaced && !facts.assistantPlaced() ? UNPLACED_REASON : null;
	},
	reserve: (_routine, roads) => roads.reserveAssistant(),
};

export const UNPLACED_REASON = "the assistant is not placed on this Gateway";

export function targetRules(routine: Routine): TargetRules {
	return targetKind(routine.target) === "assistant" ? ASSISTANT_RULES : SPAWN_RULES;
}

export function routineTeam(routine: Routine): string {
	return targetRules(routine).team(routine);
}

export function takenReason(routine: Routine): string {
	return `a session called ${routineTeam(routine)} is already open and is not this routine's`;
}

export function routineOwns(held: SessionRecord | undefined, routine: Routine): boolean {
	return targetRules(routine).owns(held, routine);
}
