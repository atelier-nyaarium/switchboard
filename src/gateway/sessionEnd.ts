// The one end of a session. `session-end-residue.test.ts` names the plain removals left.

import type { AgentBackendId } from "../shared/agent-backend.js";
import type { PersistedAgent } from "../shared/agent-persisted.js";
import type { BoardDisposition } from "../shared/board-authority.js";
import { ClaudeConversationIdSchema, type TmuxTarget } from "../shared/host-op.js";
import { driversReach, isHostSpawn } from "../shared/host-spawn.js";
import { HARNESS } from "../shared/session-harness.js";
import { resumeIdOf, type SessionRecord, type SessionStore } from "../shared/session-store.js";
import { type PurgeItem, type PurgePlace, type PurgeQueue, purgePlaceOf } from "./purgeQueue.js";

////////////////////////////////
//  Interfaces & Types

export interface SessionEndDeps {
	sessionStore: Pick<SessionStore, "getByTeam" | "teamOf" | "everyAgent" | "hostWorkdirHint">;
	forget(team: string): boolean;
	purges: Pick<PurgeQueue, "add">;
	/** One write for removal and purges; a failure retries. */
	save(): void;
	/** Cancels runs and releases the board, before the record's ids are read. */
	before(team: string, disposition: BoardDisposition): void;
	ended(team: string): void;
}

/** Never waits on host. */
export type SessionEnd = (team: string, disposition?: BoardDisposition) => boolean;

////////////////////////////////
//  Functions & Helpers

/** Foreign terminals stay untouched. */
export function ownTerminal(record: SessionRecord | undefined, teamOf: (record: SessionRecord) => string): boolean {
	return !record?.liveTeam || record.liveTeam.team === teamOf(record);
}

function conversationOf(record: SessionRecord): PurgeItem["what"] | undefined {
	const id = resumeIdOf(record);
	if (!id || !record.harness) return undefined;
	const how = HARNESS[record.harness].conversation;
	if (how.delete === "thread") {
		return driversReach(record.spawn) ? { kind: "thread", backend: how.backend, threadId: id } : undefined;
	}
	// Validate ids before filename use.
	return ClaudeConversationIdSchema.safeParse(id).success ? { kind: "claude", conversationId: id } : undefined;
}

/** Resolvable without daemon. */
function placeOf(record: SessionRecord, sessionStore: Pick<SessionStore, "hostWorkdirHint">): PurgePlace {
	return isHostSpawn(record.spawn)
		? { kind: "host", workdirHint: sessionStore.hostWorkdirHint(record), spawn: record.spawn }
		: { kind: "devcontainer", project: record.spawn };
}

/** Purge threads at origin. */
export function threadItemOf(
	backend: AgentBackendId,
	agent: Pick<PersistedAgent, "sessionId" | "requestedTarget">,
): PurgeItem | undefined {
	if (!agent.sessionId) return undefined;
	return { place: purgePlaceOf(agent.requestedTarget), what: { kind: "thread", backend, threadId: agent.sessionId } };
}

export function purgeItemsOf(record: SessionRecord, deps: Pick<SessionEndDeps, "sessionStore">): PurgeItem[] {
	const items: PurgeItem[] = [];
	if (ownTerminal(record, (held) => deps.sessionStore.teamOf(held))) {
		const place = placeOf(record, deps.sessionStore);
		const pane: TmuxTarget = {
			kind: isHostSpawn(record.spawn) ? "host" : "devcontainer",
			name: record.spawn,
			sessionName: record.id,
		};
		const conversation = conversationOf(record);
		if (conversation) items.push({ place, what: conversation, pane });
		items.push({ place, what: { kind: "files", session: pane }, pane });
	}
	for (const { backend, agent } of deps.sessionStore.everyAgent(record)) {
		const item = threadItemOf(backend, agent);
		if (item) items.push(item);
	}
	return items;
}

export function createSessionEnd(deps: SessionEndDeps): SessionEnd {
	return (team, disposition = "release") => {
		deps.before(team, disposition);
		const record = deps.sessionStore.getByTeam(team);
		const items = record ? purgeItemsOf(record, deps) : [];
		const removed = deps.forget(team);
		if (removed) {
			deps.purges.add(items);
			try {
				deps.save();
			} catch (error) {
				// Persist tick retries.
				console.warn(`[session-end] ${team}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		deps.ended(team);
		return removed;
	};
}
