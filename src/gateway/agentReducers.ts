import { type AgentResolvedTarget, sameResolvedTarget } from "../shared/agent-execution-target.js";
import { type AgentFence, classifyAcceptanceFence } from "../shared/agent-fence.js";
import {
	type AgentStoredOperation,
	type AgentStoredTurn,
	type PersistedAgent,
	PersistedAgentSchema,
} from "../shared/agent-persisted.js";
import { AGENT_ACTIVITY_MAX_ITEMS, appendAgentActivity, replaceAt } from "../shared/agent-record.js";
import type { AgentDelivery } from "../shared/agent-state.js";
import type { AgentDaemonCommand } from "../shared/agent-wire.js";

////////////////////////////////
//  Interfaces & Types

export type AgentCommandRequest = AgentDaemonCommand extends infer Command
	? Command extends AgentDaemonCommand
		? Omit<Command, "type" | "requestId">
		: never
	: never;

export type AcceptanceVerdict =
	| { kind: "ignore"; reason: string }
	/** Defer placement pending reconciliation. */
	| { kind: "reconcile" }
	/** Uncertain delivery blocks placement. */
	| { kind: "refuse" }
	| { kind: "accept"; opensTurn: boolean };

export interface AcceptanceReceipt {
	resolvedTarget: AgentResolvedTarget;
	sessionId: string;
	turnId: string;
	delivery: AgentDelivery;
}

export interface TurnTerminal {
	state: "completed" | "failed" | "interrupted";
	finalItemId?: string;
	finalResponse?: string;
	error?: string;
	reason?: string;
}

////////////////////////////////
//  Functions & Helpers

/** Only requested operations block. */
export function hasUnresolvedOperation(agent: PersistedAgent): boolean {
	return agent.operations.some((operation) => operation.state === "requested");
}

export function resolvedTargetMatchesRequest(
	requested: PersistedAgent["requestedTarget"],
	resolved: AgentResolvedTarget,
): boolean {
	if (requested.kind !== resolved.kind) return false;
	if (requested.kind === "host") return resolved.targetId === "host";
	return resolved.targetId === `container:${requested.project}` && resolved.cwd === `/workspace/${requested.project}`;
}

/** Same-stream replays preserve fences. */
export function laterFence(current: AgentFence | undefined, next: AgentFence): AgentFence {
	return current && classifyAcceptanceFence(current, next) === "duplicate" ? current : next;
}

/**
 * A requested operation's receipt is placed by the turn it names, whatever its event id: one held
 * for reconciliation replays after later frames moved the fence past it.
 */
export function decideAcceptance(
	agent: PersistedAgent,
	operation: AgentStoredOperation | undefined,
	receipt: AcceptanceReceipt,
	fence: AgentFence,
): AcceptanceVerdict {
	if (!operation) return { kind: "ignore", reason: "operation not found" };
	if (operation.state === "accepted") return { kind: "ignore", reason: "duplicate acceptance" };
	if (operation.state !== "requested") return { kind: "ignore", reason: "operation already settled" };
	if (operation.kind === "stop") return { kind: "ignore", reason: "stop cannot accept a prompt" };

	if (operation.kind === "start") {
		if (receipt.delivery !== "started") return { kind: "refuse" };
		if (!resolvedTargetMatchesRequest(agent.requestedTarget, receipt.resolvedTarget)) return { kind: "refuse" };
		return { kind: "accept", opensTurn: true };
	}

	if (
		operation.sessionId !== receipt.sessionId ||
		agent.sessionId !== receipt.sessionId ||
		!agent.resolvedTarget ||
		!sameResolvedTarget(agent.resolvedTarget, receipt.resolvedTarget)
	)
		return { kind: "refuse" };

	const quiet = agent.agentState === "idle" && agent.activeTurnId === undefined;
	const known = agent.turns.find((turn) => turn.id === receipt.turnId);
	if (classifyAcceptanceFence(agent.fence, fence) === "foreign") {
		// Accept a relaunch's new idle turn before reconciliation.
		if (receipt.delivery === "started" && quiet && !known) return { kind: "accept", opensTurn: true };
		return { kind: "reconcile" };
	}

	if (receipt.delivery === "steered") {
		if (operation.expectedTurnId !== receipt.turnId || !known) return { kind: "refuse" };
		// Terminal-first steers remain valid.
		if (known.state !== "inProgress") return quiet ? { kind: "accept", opensTurn: false } : { kind: "reconcile" };
		return agent.activeTurnId === known.id ? { kind: "accept", opensTurn: false } : { kind: "reconcile" };
	}

	if (known) {
		// Reconciliation adopted the turn before its receipt replayed.
		const opened = agent.operations.some(
			(other) => other.state === "accepted" && other.delivery === "started" && other.turnId === known.id,
		);
		return opened ? { kind: "refuse" } : { kind: "accept", opensTurn: false };
	}
	// The daemon opens new turns after predecessors end and reports them first.
	return quiet ? { kind: "accept", opensTurn: true } : { kind: "reconcile" };
}

/** Null means already retained. */
export function withActivity(
	agent: PersistedAgent,
	turnIndex: number,
	itemId: string,
	text: string,
	at: number,
	fence: AgentFence,
): PersistedAgent | null {
	const turn = agent.turns[turnIndex]!;
	const activities = appendAgentActivity(turn.activities, itemId, text, AGENT_ACTIVITY_MAX_ITEMS);
	if (!activities) return null;
	return PersistedAgentSchema.parse({
		...agent,
		turns: replaceAt(agent.turns, turnIndex, { ...turn, activities, updatedAt: Math.max(at, turn.updatedAt) }),
		fence,
		updatedAt: at,
	});
}

/** Terminals settle pending stops. */
export function withTerminal(
	agent: PersistedAgent,
	turnIndex: number,
	terminal: TurnTerminal,
	fallbackError: string,
	at: number,
	fence: AgentFence | undefined,
): PersistedAgent {
	const turn = agent.turns[turnIndex]!;
	const base = { id: turn.id, activities: turn.activities, updatedAt: at };
	const settled: AgentStoredTurn =
		terminal.state === "completed"
			? {
					...base,
					state: "completed",
					...(terminal.finalItemId === undefined ? {} : { finalItemId: terminal.finalItemId }),
					finalResponse: terminal.finalResponse ?? "",
				}
			: terminal.state === "failed"
				? { ...base, state: "failed", error: terminal.error ?? fallbackError }
				: {
						...base,
						state: "interrupted",
						...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
					};
	const operations = agent.operations.map((operation) =>
		operation.kind === "stop" && operation.state === "requested" && operation.turnId === turn.id
			? { ...operation, state: "accepted" as const, updatedAt: at }
			: operation,
	);
	return PersistedAgentSchema.parse({
		...agent,
		agentState: "idle",
		activeTurnId: undefined,
		operations,
		turns: replaceAt(agent.turns, turnIndex, settled),
		fence,
		updatedAt: at,
	});
}

export function commandFor(
	ownerKey: string,
	agent: PersistedAgent,
	operation: AgentStoredOperation,
): AgentCommandRequest | undefined {
	const head = { ownerKey, agentId: agent.agentId, operationId: operation.operationId };
	if (operation.kind === "start") {
		if (!operation.prompt) return undefined;
		return {
			...head,
			kind: "start",
			target: agent.requestedTarget,
			prompt: operation.prompt,
			...(operation.model === undefined ? {} : { model: operation.model }),
			...(agent.serviceTier === undefined ? {} : { serviceTier: agent.serviceTier }),
			...(operation.reasoningEffort === undefined ? {} : { reasoningEffort: operation.reasoningEffort }),
			...(operation.outputSchema === undefined ? {} : { outputSchema: operation.outputSchema }),
		};
	}
	if (!agent.resolvedTarget || !operation.sessionId) return undefined;
	if (operation.kind === "stop") {
		if (!operation.turnId) return undefined;
		return {
			...head,
			kind: "interrupt",
			target: agent.resolvedTarget,
			sessionId: operation.sessionId,
			turnId: operation.turnId,
		};
	}
	if (!operation.prompt) return undefined;
	const model = agent.operations.find((candidate) => candidate.kind === "start")?.model;
	return {
		...head,
		kind: "message",
		target: agent.resolvedTarget,
		sessionId: operation.sessionId,
		...(operation.expectedTurnId === undefined ? {} : { expectedTurnId: operation.expectedTurnId }),
		prompt: operation.prompt,
		...(model === undefined ? {} : { model }),
		...(agent.serviceTier === undefined ? {} : { serviceTier: agent.serviceTier }),
		...(operation.outputSchema === undefined ? {} : { outputSchema: operation.outputSchema }),
	};
}
