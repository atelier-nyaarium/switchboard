// Who a routine's reserved session belongs to. A name is not a binding, so provenance decides.

import { type Routine, routineSessionName } from "../../shared/schemasRoutine.js";
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

export function routineTeam(routine: Routine): string {
	return `${routine.target.spawn}.${routineSessionName(routine.id)}`;
}

/** Nothing holds the name, or what holds it is this routine's own. */
export function routineOwns(held: SessionRecord | undefined, routine: Routine): boolean {
	return held === undefined || held.mintedFrom === reserveKey(routine);
}

export type ReserveResult =
	/** Where the reserved session lives. */
	| { kind: "ok"; team: string }
	/** Still launching, so the window holds the occurrence for the next tick. */
	| { kind: "pending" }
	/** Something this routine did not make holds the name. */
	| { kind: "taken" };
