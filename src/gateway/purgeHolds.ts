// Who still holds what a queued delete names.

import { composeSessionName } from "../shared/session-id.js";
import { resumeIdOf, type SessionStore } from "../shared/session-store.js";
import type { PurgeItem } from "./purgeQueue.js";

////////////////////////////////
//  Interfaces & Types

/** What live state holds of one entry. */
export interface PurgeHolds {
	/** A record runs in its pane. */
	pane: boolean;
	/** That record carries the entry's own name. */
	files: boolean;
	/** `unknown` until the pane's record names its conversation. */
	conversation: boolean | "unknown";
}

export interface PurgeHoldReaders {
	sessionStore: Pick<SessionStore, "paneOwner" | "getByTeam" | "list">;
	/** Claude sessions a running run's named threads resume. */
	runSessions(): ReadonlySet<string>;
}

////////////////////////////////
//  Functions & Helpers

/** The conversation or thread an entry deletes. */
export function conversationOf(what: PurgeItem["what"]): string | undefined {
	if (what.kind === "claude") return what.conversationId;
	return what.kind === "thread" ? what.threadId : undefined;
}

/** One row per kind of holder. */
function resumed(what: PurgeItem["what"], id: string, readers: PurgeHoldReaders): boolean {
	if (readers.sessionStore.list().some((record) => resumeIdOf(record) === id)) return true;
	return what.kind === "claude" && readers.runSessions().has(id);
}

export function purgeHolds(entry: PurgeItem, readers: PurgeHoldReaders): PurgeHolds {
	const name = entry.pane && composeSessionName(entry.pane.name, entry.pane.sessionName);
	// A host pane is one pane under every host spawn point.
	const owner = name === undefined ? undefined : readers.sessionStore.paneOwner(name);
	const id = conversationOf(entry.what);
	const holder = owner === undefined ? undefined : readers.sessionStore.getByTeam(owner);
	const unnamed = owner !== undefined && (holder === undefined || resumeIdOf(holder) === undefined);
	return {
		pane: owner !== undefined,
		// Files are per spawn; another spawn holds only the pane.
		files: owner !== undefined && owner === name,
		conversation: id === undefined ? false : resumed(entry.what, id, readers) ? true : unnamed ? "unknown" : false,
	};
}
