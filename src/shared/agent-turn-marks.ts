// Persistent collection and notice marks.

import { z } from "zod";

const TurnIdsSchema = z.array(z.string().min(1));
/** Collects a resent request can still replay. */
const RECEIPTS_KEPT = 8;

export const AgentTurnMarksSchema = z
	.object({
		collected: TurnIdsSchema,
		notified: TurnIdsSchema,
		receipts: z
			.array(z.object({ operationId: z.string().min(1), turnIds: TurnIdsSchema }).strict())
			.max(RECEIPTS_KEPT)
			.optional(),
	})
	.strict();

export type AgentTurnMarks = z.infer<typeof AgentTurnMarksSchema>;

interface MarkedAgent {
	agentState: string;
	turns: readonly { id: string; state: string }[];
	turnMarks?: AgentTurnMarks;
}

const EMPTY: AgentTurnMarks = { collected: [], notified: [] };

/** Dead-agent turns are ended. */
export function turnEnded(agent: MarkedAgent, turn: { state: string }): boolean {
	return turn.state !== "inProgress" || agent.agentState === "unavailable";
}

export function marksOf(agent: MarkedAgent): AgentTurnMarks {
	return agent.turnMarks ?? EMPTY;
}

/** Legacy ended turns were collected. */
export function withTurnMarks(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || "turnMarks" in raw) return raw;
	const agent = raw as Partial<MarkedAgent>;
	if (!Array.isArray(agent.turns) || typeof agent.agentState !== "string") return raw;
	const ended = agent.turns.filter((turn) => turnEnded(agent as MarkedAgent, turn)).map((turn) => turn.id);
	return { ...raw, turnMarks: { collected: ended, notified: ended } };
}

function pruned(agent: MarkedAgent, marks: AgentTurnMarks): AgentTurnMarks {
	const held = new Set(agent.turns.map((turn) => turn.id));
	const keep = (ids: readonly string[]) => ids.filter((id) => held.has(id));
	return {
		collected: keep(marks.collected),
		notified: keep(marks.notified),
		...(marks.receipts ? { receipts: marks.receipts.slice(-RECEIPTS_KEPT) } : {}),
	};
}

/** Replays collect retries; null means unchanged. */
export function collectTurns(
	agent: MarkedAgent,
	operationId: string | undefined,
): { turnIds: string[]; marks: AgentTurnMarks | null } {
	const current = marksOf(agent);
	const receipt = current.receipts?.find((held) => held.operationId === operationId);
	if (operationId !== undefined && receipt) return { turnIds: [...receipt.turnIds], marks: null };
	const collected = new Set(current.collected);
	const turnIds = agent.turns
		.filter((turn) => turnEnded(agent, turn) && !collected.has(turn.id))
		.map((turn) => turn.id);
	// An empty answer needs no replay.
	if (turnIds.length === 0) return { turnIds, marks: null };
	const notified = new Set([...current.notified, ...turnIds]);
	return {
		turnIds,
		marks: pruned(agent, {
			collected: [...current.collected, ...turnIds],
			notified: [...notified],
			...(operationId === undefined
				? current.receipts
					? { receipts: current.receipts }
					: {}
				: { receipts: [...(current.receipts ?? []), { operationId, turnIds }] }),
		}),
	};
}

/** Null if already notified. */
export function notifyTurn(agent: MarkedAgent, turnId: string): AgentTurnMarks | null {
	const current = marksOf(agent);
	if (current.notified.includes(turnId)) return null;
	return pruned(agent, { ...current, notified: [...current.notified, turnId] });
}

export function uncollectedTurns(agent: MarkedAgent): number {
	const collected = new Set(marksOf(agent).collected);
	return agent.turns.filter((turn) => turnEnded(agent, turn) && !collected.has(turn.id)).length;
}
