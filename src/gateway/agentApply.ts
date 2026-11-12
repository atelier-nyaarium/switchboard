import type { AgentBackendDescriptor } from "../shared/agent-backend.js";
import { sameResolvedTarget } from "../shared/agent-execution-target.js";
import { classifyEventFence, fenceOf } from "../shared/agent-fence.js";
import { type AgentStoredTurn, type PersistedAgent, PersistedAgentSchema } from "../shared/agent-persisted.js";
import { AGENT_TURN_LOST_REASON, replaceAt, uncertainDeliveryState } from "../shared/agent-record.js";
import { type AgentReconciliationDecision, decideAgentReconciliation } from "../shared/agent-recovery.js";
import type { AgentDaemonFailureCode } from "../shared/agent-state.js";
import type { AgentDaemonEvent, AgentDaemonReceipt } from "../shared/agent-wire.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import type { AgentCatalogPersistence } from "./agentCatalogPersistence.js";
import { decideAcceptance, laterFence, withActivity, withTerminal } from "./agentReducers.js";
import type { AgentApplication } from "./agentRelayCore.js";

////////////////////////////////
//  Interfaces & Types

export interface AgentApplierDeps {
	backend: AgentBackendDescriptor;
	sessionStore: SessionStore;
	catalog: AgentCatalogPersistence<PersistedAgent>;
}

export interface AgentRefusal {
	code?: AgentDaemonFailureCode;
	message: string;
}

export interface AgentApplier {
	applyReceipt: (receipt: AgentDaemonReceipt, at: number) => Application;
	applyEvent: (event: AgentDaemonEvent, at: number) => Application;
	/** One-shot transient refusal. */
	takeRefusal: (operationId: string) => AgentRefusal | undefined;
}

type Application = AgentApplication<PersistedAgent>;
type Receipt<Kind extends AgentDaemonReceipt["kind"]> = Extract<AgentDaemonReceipt, { kind: Kind }>;

////////////////////////////////
//  Constants

const REFUSALS_KEPT = 256;

////////////////////////////////
//  Functions & Helpers

function ignore(reason: string): Application {
	return { disposition: "ignored", reason };
}

export function decideReconciliation(
	agent: Pick<PersistedAgent, "fence" | "activeTurnId" | "turns">,
	receipt: Pick<
		Receipt<"reconciled">,
		"daemonInstanceId" | "targetId" | "generation" | "eventId" | "turnId" | "turnState"
	>,
): AgentReconciliationDecision {
	const active = agent.activeTurnId
		? agent.turns.find((turn) => turn.id === agent.activeTurnId && turn.state === "inProgress")
		: undefined;
	return decideAgentReconciliation({
		currentFence: agent.fence,
		receiptFence: fenceOf(receipt),
		knownActiveTurn: active?.id,
		report: { turnId: receipt.turnId, turnState: receipt.turnState },
	});
}

export function createAgentApplier(deps: AgentApplierDeps): AgentApplier {
	const fallbackError = `${deps.backend.displayName} turn failed`;
	const refusals = new Map<string, AgentRefusal>();

	function locate(ownerKey: string, agentId: string): { owner: SessionRecord; agent: PersistedAgent } | undefined {
		const owner = deps.sessionStore.getByTeam(ownerKey);
		if (!owner) return undefined;
		const agent = deps.catalog.find(owner, agentId);
		return agent ? { owner, agent } : undefined;
	}

	/** A record that does not parse is `failed`, never acknowledged. */
	function commit(owner: SessionRecord, build: () => PersistedAgent, what: string): Application {
		let next: PersistedAgent;
		try {
			next = build();
		} catch {
			return { disposition: "failed", reason: `${what} did not produce a valid record` };
		}
		return deps.catalog.apply(owner, next);
	}

	function uncertain(owner: SessionRecord, agent: PersistedAgent, index: number, at: number): Application {
		const operation = agent.operations[index]!;
		const timestamp = Math.max(at, agent.updatedAt);
		return commit(
			owner,
			() =>
				PersistedAgentSchema.parse({
					...agent,
					agentState: uncertainDeliveryState(operation.kind, agent.agentState),
					operations: replaceAt(agent.operations, index, {
						...operation,
						state: "indeterminate",
						updatedAt: timestamp,
					}),
					updatedAt: timestamp,
				}),
			"an uncertain delivery",
		);
	}

	function applyAccepted(owner: SessionRecord, agent: PersistedAgent, receipt: Receipt<"accepted">, at: number) {
		const index = agent.operations.findIndex((operation) => operation.operationId === receipt.operationId);
		const operation = index < 0 ? undefined : agent.operations[index];
		const fence = fenceOf(receipt);
		const verdict = decideAcceptance(agent, operation, receipt, fence);
		if (verdict.kind === "ignore") return ignore(verdict.reason);
		if (verdict.kind === "reconcile") return { disposition: "reconcile" as const, owner, agent };
		if (verdict.kind === "refuse") return uncertain(owner, agent, index, at);
		const timestamp = Math.max(at, agent.updatedAt);
		const accepted = {
			...operation!,
			state: "accepted" as const,
			turnId: receipt.turnId,
			sessionId: receipt.sessionId,
			delivery: receipt.delivery,
			updatedAt: timestamp,
		};
		const opened: AgentStoredTurn = {
			id: receipt.turnId,
			state: "inProgress",
			activities: [],
			updatedAt: timestamp,
		};
		return commit(
			owner,
			() =>
				PersistedAgentSchema.parse({
					...agent,
					...(verdict.opensTurn
						? {
								agentState: "working",
								resolvedTarget: receipt.resolvedTarget,
								sessionId: receipt.sessionId,
								activeTurnId: receipt.turnId,
								turns: [...agent.turns, opened],
							}
						: {}),
					operations: replaceAt(agent.operations, index, accepted),
					fence: laterFence(agent.fence, fence),
					updatedAt: timestamp,
				}),
			"an acceptance",
		);
	}

	function applyInterrupt(
		owner: SessionRecord,
		agent: PersistedAgent,
		receipt: Receipt<"interruptResult">,
		at: number,
	) {
		const index = agent.operations.findIndex((operation) => operation.operationId === receipt.operationId);
		if (index < 0) return ignore("operation not found");
		const operation = agent.operations[index]!;
		if (operation.state !== "requested" || operation.kind !== "stop") return ignore("interrupt already settled");
		if (agent.sessionId !== receipt.sessionId || operation.turnId !== receipt.turnId)
			return ignore("interrupt result names another turn");
		const fence = fenceOf(receipt);
		if (classifyEventFence(agent.fence, fence) === "foreign")
			return { disposition: "reconcile" as const, owner, agent };
		const timestamp = Math.max(at, agent.updatedAt);
		// Interrupt waits for terminal.
		return commit(
			owner,
			() =>
				PersistedAgentSchema.parse({
					...agent,
					operations: replaceAt(agent.operations, index, {
						...operation,
						state: receipt.ok ? "accepted" : "indeterminate",
						updatedAt: timestamp,
					}),
					fence: laterFence(agent.fence, fence),
					updatedAt: timestamp,
				}),
			"an interrupt result",
		);
	}

	function applyReconciled(owner: SessionRecord, agent: PersistedAgent, receipt: Receipt<"reconciled">, at: number) {
		if (
			agent.sessionId !== receipt.sessionId ||
			!agent.resolvedTarget ||
			!sameResolvedTarget(agent.resolvedTarget, receipt.resolvedTarget)
		)
			return ignore("reconciliation names a different session");
		const recovery = decideReconciliation(agent, receipt);
		if (recovery.kind === "duplicate") return ignore("duplicate reconciliation");
		if (recovery.kind === "stale") return ignore("reconciliation from an older generation");
		if (recovery.kind === "askAgain") return { disposition: "reconcile" as const, owner, agent };
		const fence = fenceOf(receipt);
		const timestamp = Math.max(at, agent.updatedAt);
		return commit(
			owner,
			() => {
				let base = agent;
				if (recovery.kind === "lost") {
					const lost = agent.turns.findIndex((turn) => turn.id === recovery.turnId);
					base = withTerminal(
						agent,
						lost,
						{ state: "interrupted", reason: AGENT_TURN_LOST_REASON },
						fallbackError,
						timestamp,
						fence,
					);
				}
				const running =
					recovery.kind === "survives" || recovery.kind === "adopt" || recovery.kind === "recovering"
						? recovery.turnId
						: recovery.kind === "lost"
							? recovery.adoptTurnId
							: undefined;
				const adopted: AgentStoredTurn[] =
					running && !base.turns.some((turn) => turn.id === running)
						? [{ id: running, state: "inProgress", activities: [], updatedAt: timestamp }]
						: [];
				return PersistedAgentSchema.parse({
					...base,
					// Unconfirmed turns stay active.
					agentState: recovery.kind === "recovering" ? "recovering" : running ? "working" : "idle",
					activeTurnId: running,
					turns: [...base.turns, ...adopted],
					fence,
					updatedAt: timestamp,
				});
			},
			"a reconciliation",
		);
	}

	function applyRejected(receipt: Receipt<"rejected">, at: number): Application {
		if (!receipt.operationId) return ignore("rejected reconcile");
		const located = locate(receipt.ownerKey, receipt.agentId);
		if (!located) return ignore("agent not found");
		const { owner, agent } = located;
		const index = agent.operations.findIndex((operation) => operation.operationId === receipt.operationId);
		if (index < 0) return ignore("operation not found");
		if (agent.operations[index]!.state !== "requested") return ignore("rejection arrived after settlement");
		refusals.set(receipt.operationId, {
			...(receipt.failureCode ? { code: receipt.failureCode } : {}),
			message: receipt.error,
		});
		if (refusals.size > REFUSALS_KEPT) refusals.delete(refusals.keys().next().value as string);
		return uncertain(owner, agent, index, at);
	}

	function applyReceipt(receipt: AgentDaemonReceipt, at: number): Application {
		if (receipt.kind === "rejected") return applyRejected(receipt, at);
		const located = locate(receipt.ownerKey, receipt.agentId);
		if (!located) return ignore("agent not found");
		const { owner, agent } = located;
		if (receipt.kind === "accepted") return applyAccepted(owner, agent, receipt, at);
		if (receipt.kind === "interruptResult") return applyInterrupt(owner, agent, receipt, at);
		return applyReconciled(owner, agent, receipt, at);
	}

	function applyEvent(event: AgentDaemonEvent, at: number): Application {
		const located = locate(event.ownerKey, event.agentId);
		if (!located) return ignore("agent not found");
		const { owner, agent } = located;
		if (agent.sessionId !== event.sessionId || agent.resolvedTarget?.targetId !== event.targetId)
			return ignore("event names a different session");
		const fence = fenceOf(event);
		const standing = classifyEventFence(agent.fence, fence);
		if (standing === "duplicate") return ignore("duplicate event");
		if (standing === "foreign") return { disposition: "reconcile", owner, agent };
		const turnIndex = agent.turns.findIndex((turn) => turn.id === event.turnId);
		if (turnIndex < 0) return { disposition: "reconcile", owner, agent };
		if (agent.turns[turnIndex]!.state !== "inProgress") return ignore("turn already settled");
		if (agent.activeTurnId !== event.turnId) return { disposition: "reconcile", owner, agent };
		if (event.kind === "counter") return ignore("counter-only");
		const timestamp = Math.max(at, agent.updatedAt);
		if (event.kind === "activity") {
			let next: PersistedAgent | null;
			try {
				next = withActivity(agent, turnIndex, event.itemId, event.text, timestamp, fence);
			} catch {
				return { disposition: "failed", reason: "an activity did not produce a valid record" };
			}
			return next ? deps.catalog.apply(owner, next) : ignore("activity already retained");
		}
		return commit(
			owner,
			() => withTerminal(agent, turnIndex, event, fallbackError, timestamp, fence),
			"a terminal",
		);
	}

	function takeRefusal(operationId: string): AgentRefusal | undefined {
		const refusal = refusals.get(operationId);
		refusals.delete(operationId);
		return refusal;
	}

	return { applyReceipt, applyEvent, takeRefusal };
}
