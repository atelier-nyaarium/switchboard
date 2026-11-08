import {
	type AgentOperationIdentity,
	agentOperationFingerprintOf,
	replaceAt,
	uncertainDeliveryState,
} from "../shared/agent-record.js";
import { decideRegisterRecovery, type RegisterRecoveryDecision } from "../shared/agent-recovery.js";
import {
	type CopilotAgentCatalog,
	CopilotAgentIdSchema,
	type CopilotDaemonEvent,
	type CopilotDaemonFailureCode,
	type CopilotDaemonReceipt,
	type CopilotExecutionTarget,
	CopilotExecutionTargetSchema,
	CopilotOperationIdSchema,
	type CopilotPersistedAgent,
	CopilotPersistedAgentSchema,
	CopilotPromptSchema,
	copilotOperationIdentity,
} from "../shared/copilot-agent.js";
import type { SessionRecord } from "../shared/session-store.js";
import type { AgentCatalogRetirement, AgentCollection } from "./agentCatalogPersistence.js";
import { AgentCatalogPersistence } from "./agentCatalogPersistence.js";
import { resolveAgentExecutionTarget } from "./agentExecutionTarget.js";
import { AgentTransitionError, validateTimestamp } from "./agentRouteEnvelope.js";
import { type CopilotReceiptApplier, createCopilotReceiptApplier } from "./copilotAgentApply.js";
import type {
	CopilotAgentServiceDeps,
	CopilotApplication,
	CopilotExistingAgentIntentInput,
	CopilotIntentInput,
	CopilotStopIntentInput,
	CopilotTransitionResult,
	OwnedCopilotAgent,
} from "./copilotAgentTypes.js";

export function decideCopilotRegisterRecovery(
	agent: Pick<CopilotPersistedAgent, "agentState" | "operations">,
	liveDaemonInstanceId: string,
): RegisterRecoveryDecision {
	return decideRegisterRecovery(agent.agentState, agent.operations, liveDaemonInstanceId);
}

export class CopilotAgentService {
	private readonly persistence: AgentCatalogPersistence<CopilotPersistedAgent>;
	private readonly receiptApplier: CopilotReceiptApplier;

	constructor(private readonly deps: CopilotAgentServiceDeps) {
		this.persistence = new AgentCatalogPersistence({
			read: (owner) => deps.sessionStore.copilotCatalog(owner),
			writer: deps.catalogWriter,
		});
		this.receiptApplier = createCopilotReceiptApplier({
			sessionStore: deps.sessionStore,
			catalog: this.persistence,
		});
	}

	resolveOwner(req: Request): SessionRecord | null {
		return this.deps.auth.resolveConfirmedManagedSession(req);
	}

	ownerKeyOf(owner: SessionRecord): string {
		return this.deps.sessionStore.teamOf(owner);
	}

	listOwnedAgents(owner: SessionRecord): readonly CopilotPersistedAgent[] {
		return this.deps.sessionStore.listCopilotAgents(owner);
	}

	findOwnedAgent(owner: SessionRecord, agentId: string): CopilotPersistedAgent | undefined {
		return this.persistence.find(owner, agentId);
	}

	retire(owner: SessionRecord, agentId: string): AgentCatalogRetirement {
		return this.persistence.retire(owner, agentId);
	}

	collect(
		owner: SessionRecord,
		agentId: string,
		operationId: string | undefined,
	): AgentCollection<CopilotPersistedAgent> | undefined {
		return this.persistence.collect(owner, agentId, operationId, (candidate) =>
			CopilotPersistedAgentSchema.parse(candidate),
		);
	}

	markTurnNotified(owner: SessionRecord, agentId: string, turnId: string): boolean {
		return this.persistence.markNotified(owner, agentId, turnId, (candidate) =>
			CopilotPersistedAgentSchema.parse(candidate),
		);
	}

	retagRunId(owner: SessionRecord, agentId: string, fromRunId: string, toRunId: string, at: number): boolean {
		const current = this.persistence.find(owner, agentId);
		if (
			!current ||
			current.runId !== fromRunId ||
			current.turns.some((turn) => turn.state === "inProgress") ||
			current.operations.some((operation) => operation.state === "requested")
		)
			return false;
		const next = CopilotPersistedAgentSchema.safeParse({
			...current,
			runId: toRunId,
			updatedAt: Math.max(at, current.updatedAt),
		});
		return next.success && this.persistence.apply(owner, next.data).disposition === "applied";
	}

	resolveExecutionTarget(owner: SessionRecord, cwd?: string): CopilotExecutionTarget | null {
		return resolveAgentExecutionTarget(owner, cwd, this.deps.sessionStore, this.deps.offlineCatalog);
	}

	resolveOwnedAgent(req: Request, agentId: string): OwnedCopilotAgent | null {
		if (!CopilotAgentIdSchema.safeParse(agentId).success) return null;
		const owner = this.resolveOwner(req);
		if (!owner) return null;
		const agent = this.persistence.find(owner, agentId);
		return agent ? { owner, agent } : null;
	}

	beginStart(owner: SessionRecord, input: CopilotIntentInput): CopilotTransitionResult {
		const agentId = CopilotAgentIdSchema.parse(input.agentId);
		const operationId = CopilotOperationIdSchema.parse(input.operationId);
		const prompt = CopilotPromptSchema.parse(input.prompt);
		const target = CopilotExecutionTargetSchema.parse(input.target);
		const at = validateTimestamp(input.at);
		const identity = copilotOperationIdentity({ kind: "start", agentId, prompt, model: input.model });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		if (catalog.agents.some((agent) => agent.agentId === agentId))
			throw new AgentTransitionError("operation_conflict", "agent ID is already in use");
		const agent = CopilotPersistedAgentSchema.parse({
			version: 1,
			agentId,
			...(input.runId === undefined ? {} : { runId: input.runId }),
			agentState: "creating",
			requestedTarget: target,
			turnMarks: { collected: [], notified: [] },
			operations: [
				{
					operationId,
					...(input.daemonInstanceId === undefined ? {} : { daemonInstanceId: input.daemonInstanceId }),
					kind: "start",
					prompt,
					...(input.model === undefined ? {} : { model: input.model }),
					...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
					...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
					fingerprint,
					state: "requested",
					createdAt: at,
					updatedAt: at,
				},
			],
			turns: [],
			createdAt: at,
			updatedAt: at,
		});
		return this.commit(owner, catalog, [...catalog.agents, agent], agent, operationId);
	}

	beginMessage(owner: SessionRecord, input: CopilotExistingAgentIntentInput): CopilotTransitionResult {
		const agentId = CopilotAgentIdSchema.parse(input.agentId);
		const operationId = CopilotOperationIdSchema.parse(input.operationId);
		const prompt = CopilotPromptSchema.parse(input.prompt);
		const at = validateTimestamp(input.at);
		const identity = copilotOperationIdentity({ kind: "message", agentId, prompt });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		const index = this.indexOf(catalog, agentId);
		const current = catalog.agents[index]!;
		// A working agent takes it as a steer; the daemon says which it was.
		if (
			!current.sessionId ||
			!current.resolvedTarget ||
			(current.agentState !== "idle" && current.agentState !== "working")
		)
			throw new AgentTransitionError("state_conflict", "Copilot agent cannot take a message now");
		if (current.operations.some((operation) => operation.state === "requested"))
			throw new AgentTransitionError("state_conflict", "Copilot agent has an unresolved operation");
		const timestamp = Math.max(at, current.updatedAt);
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			operations: [
				...current.operations,
				{
					operationId,
					...(input.daemonInstanceId === undefined ? {} : { daemonInstanceId: input.daemonInstanceId }),
					kind: "message",
					prompt,
					...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
					fingerprint,
					state: "requested",
					sessionId: current.sessionId,
					...(current.agentState === "working" && current.activeTurnId
						? { expectedTurnId: current.activeTurnId }
						: {}),
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			],
			updatedAt: timestamp,
		});
		return this.commit(owner, catalog, replaceAt(catalog.agents, index, next), next, operationId);
	}

	beginStop(owner: SessionRecord, input: CopilotStopIntentInput): CopilotTransitionResult {
		const agentId = CopilotAgentIdSchema.parse(input.agentId);
		const operationId = CopilotOperationIdSchema.parse(input.operationId);
		const at = validateTimestamp(input.at);
		const identity = copilotOperationIdentity({ kind: "stop", agentId });
		const fingerprint = agentOperationFingerprintOf(identity);
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		const index = this.indexOf(catalog, agentId);
		const current = catalog.agents[index]!;
		if (
			!current.sessionId ||
			!current.resolvedTarget ||
			(current.agentState !== "idle" && current.agentState !== "working")
		) {
			throw new AgentTransitionError("state_conflict", "Copilot agent cannot be stopped now");
		}
		if (current.operations.some((operation) => operation.state === "requested"))
			throw new AgentTransitionError("state_conflict", "Copilot agent has an unresolved operation");
		const timestamp = Math.max(at, current.updatedAt);
		const noOp = current.agentState === "idle";
		const operation = {
			operationId,
			...(input.daemonInstanceId === undefined ? {} : { daemonInstanceId: input.daemonInstanceId }),
			kind: "stop" as const,
			fingerprint,
			state: noOp ? ("accepted" as const) : ("requested" as const),
			sessionId: current.sessionId,
			turnId: noOp ? undefined : current.activeTurnId,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			operations: [...current.operations, operation],
			updatedAt: timestamp,
		});
		return this.commit(owner, catalog, replaceAt(catalog.agents, index, next), next, operationId);
	}

	applyReceipt(receipt: CopilotDaemonReceipt, at: number): CopilotApplication {
		return this.receiptApplier.applyReceipt(receipt, at);
	}

	applyEvent(event: CopilotDaemonEvent, at: number): CopilotApplication {
		return this.receiptApplier.applyEvent(event, at);
	}

	abandonDelivery(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		at: number,
	): CopilotPersistedAgent | undefined {
		const current = this.listOwnedAgents(owner).find((agent) => agent.agentId === agentId);
		if (!current) return undefined;
		const operationIndex = current.operations.findIndex((operation) => operation.operationId === operationId);
		if (operationIndex < 0 || current.operations[operationIndex]!.state !== "requested") return current;
		const operation = {
			...current.operations[operationIndex]!,
			state: "indeterminate" as const,
			updatedAt: Math.max(at, current.updatedAt),
		};
		const next = CopilotPersistedAgentSchema.parse({
			...current,
			agentState: uncertainDeliveryState(operation.kind, current.agentState),
			operations: replaceAt(current.operations, operationIndex, operation),
			updatedAt: Math.max(at, current.updatedAt),
		});
		const applied = this.persistence.apply(owner, next);
		return applied.disposition === "applied" ? applied.agent : current;
	}

	abandonStaleOperations(
		owner: SessionRecord,
		agent: CopilotPersistedAgent,
		daemonInstanceId: string,
		at: number,
	): CopilotApplication {
		const current = this.persistence.find(owner, agent.agentId);
		if (!current) return { disposition: "ignored", reason: "agent left the catalog" };
		const recovery = decideCopilotRegisterRecovery(current, daemonInstanceId);
		if (recovery.staleOperationIds.length === 0)
			return { disposition: "ignored", reason: "agent has no operation from another daemon" };
		const staleIds = new Set(recovery.staleOperationIds);
		const timestamp = Math.max(at, current.updatedAt);
		try {
			const next = CopilotPersistedAgentSchema.parse({
				...current,
				agentState: recovery.nextAgentState,
				operations: current.operations.map((operation) =>
					staleIds.has(operation.operationId)
						? { ...operation, state: "indeterminate" as const, updatedAt: timestamp }
						: operation,
				),
				updatedAt: timestamp,
			});
			return this.persistence.apply(owner, next);
		} catch {
			return { disposition: "failed", reason: "stale operations did not produce a valid record" };
		}
	}

	takeRefusal(operationId: string): { code?: CopilotDaemonFailureCode; message: string } | undefined {
		return this.receiptApplier.takeRefusal(operationId);
	}

	private commit(
		owner: SessionRecord,
		catalog: CopilotAgentCatalog,
		agents: readonly CopilotPersistedAgent[],
		agent: CopilotPersistedAgent,
		operationId: string,
	): CopilotTransitionResult {
		return this.persistence.commit(owner, catalog, agents, agent, operationId);
	}

	private replay(
		owner: SessionRecord,
		operationId: string,
		identity: AgentOperationIdentity,
	): CopilotTransitionResult | null {
		return this.persistence.replay(owner, operationId, identity);
	}

	private catalog(owner: SessionRecord): CopilotAgentCatalog {
		return this.persistence.read(owner);
	}

	private indexOf(catalog: CopilotAgentCatalog, agentId: string): number {
		return this.persistence.indexOf(catalog, agentId);
	}
}
