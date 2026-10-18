// The assistant's one session. A name is not a binding, so provenance decides, as for a routine.

import { composeSessionName } from "./session-id.js";

export const ASSISTANT_SPAWN = "host";
export const ASSISTANT_SESSION_NAME = "assistant";
export const ASSISTANT_TEAM = composeSessionName(ASSISTANT_SPAWN, ASSISTANT_SESSION_NAME);

/** `createSession` provenance shape: `${conversationId}:${opId}`. */
export const ASSISTANT_RESERVE_KEY = "assistant:reserve";

/** Provisioned by the Gateway, not merely sharing the name. */
export function isAssistantRecord(record: { spawn: string; id: string; mintedFrom?: string } | undefined): boolean {
	return (
		record !== undefined &&
		record.spawn === ASSISTANT_SPAWN &&
		record.id === ASSISTANT_SESSION_NAME &&
		record.mintedFrom === ASSISTANT_RESERVE_KEY
	);
}
