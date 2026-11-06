// Delegated agents' turns, told to the session that owns them: each completion, and progress while one runs.

import type { AgentBackendId } from "../shared/agent-backend.js";
import {
	AGENT_NOTICE_SOURCE,
	AGENT_PROGRESS_EVERY_MS,
	type AgentNotice,
	agentNoticeAct,
	agentNoticeLine,
} from "../shared/agent-notice.js";
import type { AwarenessObservation, AwarenessSubscriber } from "../shared/awareness-types.js";

////////////////////////////////
//  Interfaces & Types

/** One agent as the catalogs hold it, read fresh each tick. */
export interface RosterAgent {
	ownerKey: string;
	family: AgentBackendId;
	agentId: string;
	agentState: string;
	turns: readonly { id: string; state: string; updatedAt: number; notes: readonly string[] }[];
}

export interface AgentWatch {
	tick(): void;
}

////////////////////////////////
//  Functions & Helpers

/** Progress pushes on its own deadline, though it asks nothing. */
export const agentAwarenessSubscriber: AwarenessSubscriber<AgentNotice> = {
	source: AGENT_NOTICE_SOURCE,
	act: (_sessionKey, _pre, post) => (post ? agentNoticeAct(post) : "no_act"),
	push: (_sessionKey, _pre, post) => post?.kind === "progress",
	render: (_sessionKey, changes) =>
		changes.flatMap((change) => (change.post ? [agentNoticeLine(change.post)] : [])).join("\n\n"),
};

/**
 * Tells each settled turn once, and each running turn every `everyMs`. A turn settled before the
 * watch began is history, so a restart announces only what settled since, the downtime included.
 */
export function createAgentWatch(deps: {
	roster: () => readonly RosterAgent[];
	observe: (observations: readonly AwarenessObservation<AgentNotice>[]) => void;
	now: () => number;
	everyMs?: number;
	/** False for an owner told only completions. */
	takesProgress?: (ownerKey: string) => boolean;
}): AgentWatch {
	const everyMs = deps.everyMs ?? AGENT_PROGRESS_EVERY_MS;
	const told = new Set<string>();
	const running = new Map<string, { since: number; lastNotice: number }>();
	const began = deps.now();

	return {
		tick() {
			const now = deps.now();
			const observations: AwarenessObservation<AgentNotice>[] = [];
			const present = new Set<string>();
			for (const agent of deps.roster()) {
				// A recovering agent may resume its turn; only a dead one ends it.
				const lost = agent.agentState === "unavailable";
				for (const turn of agent.turns) {
					// Per turn, so two quick completions stay two notices.
					const identity = `${agent.family}:${agent.agentId}:${turn.id}`;
					const key = `${agent.ownerKey}\n${identity}`;
					present.add(key);
					const settled = turn.state !== "inProgress";
					if (settled || lost) {
						if (told.has(key)) continue;
						told.add(key);
						running.delete(key);
						if (settled && turn.updatedAt < began) continue;
						const outcome = settled ? turn.state : agent.agentState;
						const post: AgentNotice = {
							kind: "done",
							family: agent.family,
							agentId: agent.agentId,
							outcome,
						};
						observations.push({ sessionKey: agent.ownerKey, identity, pre: undefined, post });
						continue;
					}
					const held = running.get(key);
					if (!held) {
						running.set(key, { since: now, lastNotice: now });
						continue;
					}
					if (now - held.lastNotice < everyMs) continue;
					held.lastNotice = now;
					if (deps.takesProgress?.(agent.ownerKey) === false) continue;
					const post: AgentNotice = {
						kind: "progress",
						family: agent.family,
						agentId: agent.agentId,
						minutes: Math.round((now - held.since) / 60_000),
						notes: turn.notes,
					};
					observations.push({ sessionKey: agent.ownerKey, identity, pre: undefined, post });
				}
			}
			for (const key of told) if (!present.has(key)) told.delete(key);
			for (const key of running.keys()) if (!present.has(key)) running.delete(key);
			if (observations.length > 0) deps.observe(observations);
		},
	};
}
