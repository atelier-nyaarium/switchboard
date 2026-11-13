// Shared list and collect shapes.

import type { AgentBackendId } from "./agent-backend.js";
import { type AgentTurnMarks, turnEnded, uncollectedTurns } from "./agent-turn-marks.js";

export const AGENT_LIST_DEFAULT = 20;
export const AGENT_LIST_MAX = 50;
export const AGENT_THREAD_TTL_MS = 24 * 60 * 60_000;
export const AGENT_AGE_PASS_MS = 60 * 60_000;

interface ListedAgent {
	agentId: string;
	agentState: string;
	runId?: string;
	turns: readonly { id: string; state: string }[];
	turnMarks?: AgentTurnMarks;
	updatedAt: number;
}

export interface AgentListRow {
	agentId: string;
	backend: AgentBackendId;
	model?: string;
	agentState: string;
	running: boolean;
	uncollected: number;
	turnCount: number;
	lastActiveAt: number;
	latestPromptFirstLine?: string;
}

/** Starting or running. */
function busy(agent: ListedAgent): boolean {
	return agent.agentState === "creating" || agent.turns.some((turn) => !turnEnded(agent, turn));
}

/** Busy or uncollected. */
export function listedAgent(agent: ListedAgent): boolean {
	return agent.runId === undefined && (busy(agent) || uncollectedTurns(agent) > 0);
}

/**
 * Expires after a day, or after threadless turns are collected.
 * Never during a running workflow, active work, recovery, or requested operations.
 */
export function threadExpired(
	agent: ListedAgent & { operations: readonly { state: string }[]; expiredAt?: number },
	now: number,
	runRunning: (runId: string) => boolean,
): boolean {
	if (agent.expiredAt !== undefined) return uncollectedTurns(agent) === 0;
	if (agent.runId !== undefined && runRunning(agent.runId)) return false;
	if (busy(agent) || agent.agentState === "recovering") return false;
	if (agent.operations.some((operation) => operation.state === "requested")) return false;
	return now - agent.updatedAt >= AGENT_THREAD_TTL_MS;
}

export function agentListRow(
	agent: ListedAgent,
	backend: AgentBackendId,
	extra: { model?: string; latestPrompt?: string },
): AgentListRow {
	const prompt = extra.latestPrompt?.split("\n", 1)[0]?.slice(0, 256);
	return {
		agentId: agent.agentId,
		backend,
		...(extra.model === undefined ? {} : { model: extra.model }),
		agentState: agent.agentState,
		running: busy(agent),
		uncollected: uncollectedTurns(agent),
		turnCount: agent.turns.length,
		lastActiveAt: agent.updatedAt,
		...(prompt === undefined ? {} : { latestPromptFirstLine: prompt }),
	};
}

/** Newest first; includes named agents. */
export function agentListAnswer<T extends ListedAgent>(
	agents: readonly T[],
	request: { agentId?: string; limit?: number },
	row: (agent: T) => AgentListRow,
): { agents: AgentListRow[]; omitted: number } {
	const selected =
		request.agentId === undefined
			? agents.filter(listedAgent)
			: agents.filter((agent) => agent.agentId === request.agentId && agent.runId === undefined);
	const limit = Math.min(request.limit ?? AGENT_LIST_DEFAULT, AGENT_LIST_MAX);
	const shown = selected.slice(-limit).reverse();
	return { agents: shown.map(row), omitted: selected.length - shown.length };
}

/** Collected turns and current turn. */
export function collectAnswer<T extends ListedAgent, V>(
	agent: T,
	turnIds: readonly string[],
	view: (turn: T["turns"][number]) => V,
): { agentId: string; agentState: string; running: string | null; turns: V[] } {
	const taken = new Set(turnIds);
	const running = agent.turns.find((turn) => !turnEnded(agent, turn));
	return {
		agentId: agent.agentId,
		agentState: agent.agentState,
		running: running?.id ?? null,
		turns: agent.turns.filter((turn) => taken.has(turn.id)).map(view),
	};
}
