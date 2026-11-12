// Delegated agents' turns, told to the session that owns them: each completion, and progress while one runs.

import type { AgentBackendId } from "../shared/agent-backend.js";
import {
	type AgentProgressCounts,
	deltaAgentProgressCounts,
	emptyAgentProgressCounts,
} from "../shared/agent-counter.js";
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
	backend: AgentBackendId;
	agentId: string;
	runId?: string;
	agentState: string;
	turns: readonly {
		id: string;
		state: string;
		collected: boolean;
		notified: boolean;
		updatedAt: number;
		notes: readonly string[];
		progress?: AgentProgressCounts;
	}[];
}

export interface AgentWatch {
	tick(): void;
}

////////////////////////////////
//  Functions & Helpers

/** Pushes progress; marks completions. */
export function createAgentAwarenessSubscriber(
	markNotified: (sessionKey: string, backend: AgentBackendId, agentId: string, turnId: string) => void,
): AwarenessSubscriber<AgentNotice> {
	return {
		source: AGENT_NOTICE_SOURCE,
		act: (_sessionKey, _pre, post) => (post ? agentNoticeAct(post) : "no_act"),
		push: (_sessionKey, _pre, post) => post?.kind === "progress",
		render: (_sessionKey, changes) =>
			changes.flatMap((change) => (change.post ? [agentNoticeLine(change.post)] : [])).join("\n\n"),
		delivered: (sessionKey, change) => {
			if (change.post?.kind !== "done") return;
			markNotified(sessionKey, change.post.backend, change.post.agentId, turnOfIdentity(change.identity));
		},
	};
}

export function agentTurnIdentity(backend: AgentBackendId, agentId: string, turnId: string): string {
	return `${backend}:${agentId}:${turnId}`;
}

function turnOfIdentity(identity: string): string {
	return identity.split(":").slice(2).join(":");
}

/**
 * Reports turn changes.
 */
export function createAgentWatch(deps: {
	roster: () => readonly RosterAgent[];
	observe: (observations: readonly AwarenessObservation<AgentNotice>[]) => void;
	now: () => number;
	everyMs?: number;
}): AgentWatch {
	const everyMs = deps.everyMs ?? AGENT_PROGRESS_EVERY_MS;
	const running = new Map<string, { since: number; lastNotice: number; lastCounts: AgentProgressCounts }>();

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
					const identity = agentTurnIdentity(agent.backend, agent.agentId, turn.id);
					const key = `${agent.ownerKey}\n${identity}`;
					present.add(key);
					const settled = turn.state !== "inProgress";
					if (settled || lost) {
						running.delete(key);
						if (turn.notified || turn.collected) continue;
						const outcome = settled ? turn.state : agent.agentState;
						const post: AgentNotice = {
							kind: "done",
							backend: agent.backend,
							agentId: agent.agentId,
							outcome,
						};
						observations.push({ sessionKey: agent.ownerKey, identity, pre: undefined, post });
						continue;
					}
					const held = running.get(key);
					if (!held) {
						running.set(key, { since: now, lastNotice: now, lastCounts: emptyAgentProgressCounts() });
						continue;
					}
					if (now - held.lastNotice < everyMs) continue;
					held.lastNotice = now;
					const currentCounts = turn.progress ?? emptyAgentProgressCounts();
					const counts = deltaAgentProgressCounts(currentCounts, held.lastCounts);
					held.lastCounts = currentCounts;
					const post: AgentNotice = {
						kind: "progress",
						backend: agent.backend,
						agentId: agent.agentId,
						minutes: Math.round((now - held.since) / 60_000),
						notes: turn.notes,
						counts,
					};
					observations.push({ sessionKey: agent.ownerKey, identity, pre: undefined, post });
				}
			}
			for (const key of running.keys()) if (!present.has(key)) running.delete(key);
			if (observations.length > 0) deps.observe(observations);
		},
	};
}
