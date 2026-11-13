import { AgentExecutionTargetSchema } from "../shared/agent-execution-target.js";
import {
	AgentOperationIdSchema,
	AgentPromptSchema,
	agentIdSchemaFor,
	agentOperationIdentity,
} from "../shared/agent-identity.js";
import { interruptingOperation, type PersistedAgent, PersistedAgentSchema } from "../shared/agent-persisted.js";
import {
	type AgentOperationIdentity,
	agentOperationFingerprintOf,
	replaceAt,
	uncertainDeliveryState,
} from "../shared/agent-record.js";
import {
	type AgentReconciliationReport,
	decideRegisterRecovery,
	type RegisterRecoveryDecision,
} from "../shared/agent-recovery.js";
import { uncollectedTurns } from "../shared/agent-turn-marks.js";
import type { AgentDaemonEvent, AgentDaemonReceipt } from "../shared/agent-wire.js";
import type { SessionRecord } from "../shared/session-store.js";
import { type AgentApplier, type AgentRefusal, createAgentApplier } from "./agentApply.js";
import {
	type AgentCatalog,
	AgentCatalogPersistence,
	type AgentCatalogRetirement,
	type AgentCollection,
	type CatalogConfirmation,
} from "./agentCatalogPersistence.js";
import { resolveAgentExecutionTarget } from "./agentExecutionTarget.js";
import { hasUnresolvedOperation } from "./agentReducers.js";
import { type AgentApplication, inRecord } from "./agentRelayCore.js";
import { AgentTransitionError, validateTimestamp } from "./agentRouteEnvelope.js";
import type {
	AgentMessageIntent,
	AgentServiceDeps,
	AgentStartIntent,
	AgentStopIntent,
	AgentTransition,
	OwnedAgent,
} from "./agentTypes.js";

type Application = AgentApplication<PersistedAgent>;

export function decideAgentRegisterRecovery(
	agent: Pick<PersistedAgent, "agentState" | "operations">,
	liveDaemonInstanceId: string,
): RegisterRecoveryDecision {
	return decideRegisterRecovery(agent.agentState, agent.operations, liveDaemonInstanceId);
}

const parseAgent = (candidate: unknown): PersistedAgent => PersistedAgentSchema.parse(candidate);

export class AgentService {
	private readonly persistence: AgentCatalogPersistence<PersistedAgent>;
	private readonly applier: AgentApplier;
	private readonly agentId: ReturnType<typeof agentIdSchemaFor>;

	constructor(private readonly deps: AgentServiceDeps) {
		const backend = deps.backend.id;
		this.agentId = agentIdSchemaFor(backend);
		this.persistence = new AgentCatalogPersistence({
			read: (owner) => deps.sessionStore.agentCatalog(owner, backend),
			writer: deps.catalogWriter,
			retiring: (_owner, agent) => deps.threadEnded?.(agent),
		});
		this.applier = createAgentApplier({
			backend: deps.backend,
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

	ownerOf(ownerKey: string): SessionRecord | undefined {
		return this.deps.sessionStore.getByTeam(ownerKey);
	}

	listOwnedAgents(owner: SessionRecord): readonly PersistedAgent[] {
		return this.deps.sessionStore.listAgents(owner, this.deps.backend.id);
	}

	findOwnedAgent(owner: SessionRecord, agentId: string): PersistedAgent | undefined {
		return this.persistence.find(owner, agentId);
	}

	retire(owner: SessionRecord, agentId: string): AgentCatalogRetirement {
		return this.persistence.retire(owner, agentId);
	}

	collect(
		owner: SessionRecord,
		agentId: string,
		operationId: string | undefined,
		at: number,
	): AgentCollection<PersistedAgent> | undefined {
		return this.persistence.collect(owner, agentId, operationId, at, parseAgent);
	}

	/**
	 * Ends every named thread in one catalog write, since a write is the whole snapshot.
	 * Uncollected turns keep the threadless record. Answers how many ended.
	 */
	expireAll(owner: SessionRecord, agentIds: ReadonlySet<string>, at: number): number {
		const undos: Array<(() => void) | undefined> = [];
		const landed = this.persistence.rewrite(owner, (current) => {
			if (!agentIds.has(current.agentId)) return undefined;
			if (current.runId !== undefined || uncollectedTurns(current) === 0) {
				if (current.turns.some((turn) => turn.state === "inProgress") || hasUnresolvedOperation(current))
					return undefined;
				undos.push(this.deps.threadEnded?.(current));
				return null;
			}
			if (current.expiredAt !== undefined) return undefined;
			const {
				sessionId: _thread,
				resolvedTarget: _target,
				fence: _fence,
				activeTurnId: _turn,
				...rest
			} = current;
			const next = PersistedAgentSchema.safeParse({ ...rest, agentState: "unavailable", expiredAt: at });
			if (!next.success) return undefined;
			undos.push(this.deps.threadEnded?.(current));
			return next.data;
		});
		if (landed) return undos.length;
		for (const undo of undos) undo?.();
		return 0;
	}

	markTurnNotified(owner: SessionRecord, agentId: string, turnId: string): boolean {
		return this.persistence.markNotified(owner, agentId, turnId, parseAgent);
	}

	/** Retag only settled agents. */
	retagRunId(owner: SessionRecord, agentId: string, fromRunId: string, toRunId: string, at: number): boolean {
		const current = this.persistence.find(owner, agentId);
		if (
			!current ||
			current.runId !== fromRunId ||
			current.turns.some((turn) => turn.state === "inProgress") ||
			hasUnresolvedOperation(current)
		)
			return false;
		const next = PersistedAgentSchema.safeParse({
			...current,
			runId: toRunId,
			updatedAt: Math.max(at, current.updatedAt),
		});
		return next.success && inRecord(this.persistence.apply(owner, next.data));
	}

	resolveExecutionTarget(owner: SessionRecord, cwd?: string) {
		return resolveAgentExecutionTarget(owner, cwd, this.deps.sessionStore, this.deps.offlineCatalog);
	}

	resolveOwnedAgent(req: Request, agentId: string): OwnedAgent | null {
		if (!this.agentId.safeParse(agentId).success) return null;
		const owner = this.resolveOwner(req);
		if (!owner) return null;
		const agent = this.persistence.find(owner, agentId);
		return agent ? { owner, agent } : null;
	}

	beginStart(owner: SessionRecord, input: AgentStartIntent): AgentTransition {
		const agentId = this.agentId.parse(input.agentId);
		const operationId = AgentOperationIdSchema.parse(input.operationId);
		const prompt = AgentPromptSchema.parse(input.prompt);
		const target = AgentExecutionTargetSchema.parse(input.target);
		const at = validateTimestamp(input.at);
		const identity = agentOperationIdentity({ kind: "start", agentId, prompt, model: input.model });
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		if (catalog.agents.some((agent) => agent.agentId === agentId))
			throw new AgentTransitionError("operation_conflict", "agent ID is already in use");
		const agent = PersistedAgentSchema.parse({
			version: 2,
			agentId,
			...(input.runId === undefined ? {} : { runId: input.runId }),
			agentState: "creating",
			requestedTarget: target,
			...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
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
					fingerprint: agentOperationFingerprintOf(identity),
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

	beginMessage(owner: SessionRecord, input: AgentMessageIntent): AgentTransition {
		const agentId = this.agentId.parse(input.agentId);
		const operationId = AgentOperationIdSchema.parse(input.operationId);
		const prompt = AgentPromptSchema.parse(input.prompt);
		const at = validateTimestamp(input.at);
		const identity = agentOperationIdentity({ kind: "message", agentId, prompt });
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		const index = this.persistence.indexOf(catalog, agentId);
		const current = catalog.agents[index]!;
		// Daemon sets delivery mode.
		if (!this.operational(current))
			throw new AgentTransitionError("state_conflict", "agent cannot accept a follow-up in its current state");
		if (interruptingOperation(current))
			throw new AgentTransitionError("state_conflict", "agent cannot accept a message while interrupting");
		if (hasUnresolvedOperation(current))
			throw new AgentTransitionError("state_conflict", "agent has an unresolved operation");
		const timestamp = Math.max(at, current.updatedAt);
		const next = PersistedAgentSchema.parse({
			...current,
			...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
			operations: [
				...current.operations,
				{
					operationId,
					...(input.daemonInstanceId === undefined ? {} : { daemonInstanceId: input.daemonInstanceId }),
					kind: "message",
					prompt,
					...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
					fingerprint: agentOperationFingerprintOf(identity),
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

	beginStop(owner: SessionRecord, input: AgentStopIntent): AgentTransition {
		const agentId = this.agentId.parse(input.agentId);
		const operationId = AgentOperationIdSchema.parse(input.operationId);
		const at = validateTimestamp(input.at);
		const identity = agentOperationIdentity({ kind: "stop", agentId });
		const replay = this.replay(owner, operationId, identity);
		if (replay) return replay;
		const catalog = this.catalog(owner);
		const index = this.persistence.indexOf(catalog, agentId);
		const current = catalog.agents[index]!;
		if (!this.operational(current))
			throw new AgentTransitionError("state_conflict", "agent cannot be stopped in its current state");
		if (interruptingOperation(current))
			throw new AgentTransitionError("state_conflict", "an interrupt is already pending");
		if (hasUnresolvedOperation(current))
			throw new AgentTransitionError("state_conflict", "agent has an unresolved operation");
		const timestamp = Math.max(at, current.updatedAt);
		// Idle stops settle immediately.
		const idle = current.agentState === "idle";
		const next = PersistedAgentSchema.parse({
			...current,
			operations: [
				...current.operations,
				{
					operationId,
					...(input.daemonInstanceId === undefined ? {} : { daemonInstanceId: input.daemonInstanceId }),
					kind: "stop",
					fingerprint: agentOperationFingerprintOf(identity),
					state: idle ? "accepted" : "requested",
					sessionId: current.sessionId,
					...(idle || !current.activeTurnId ? {} : { turnId: current.activeTurnId }),
					createdAt: timestamp,
					updatedAt: timestamp,
				},
			],
			updatedAt: timestamp,
		});
		return this.commit(owner, catalog, replaceAt(catalog.agents, index, next), next, operationId);
	}

	applyReceipt(receipt: AgentDaemonReceipt, at: number, closing = false): Application {
		return this.applier.applyReceipt(receipt, at, closing);
	}

	applyEvent(event: AgentDaemonEvent, at: number, held = false): Application {
		return this.applier.applyEvent(event, at, held);
	}

	closeHeld(
		ownerKey: string,
		agentId: string,
		report: AgentReconciliationReport | undefined,
		at: number,
	): Application {
		return this.applier.closeHeld(ownerKey, agentId, report, at);
	}

	abandonOperation(ownerKey: string, agentId: string, operationId: string, at: number): Application {
		return this.applier.abandonOperation(ownerKey, agentId, operationId, at);
	}

	/** Abandons unconfirmed deliveries. */
	abandonDelivery(
		owner: SessionRecord,
		agentId: string,
		operationId: string,
		at: number,
	): PersistedAgent | undefined {
		const current = this.persistence.find(owner, agentId);
		if (!current) return undefined;
		const index = current.operations.findIndex((operation) => operation.operationId === operationId);
		if (index < 0 || current.operations[index]!.state !== "requested") return current;
		const timestamp = Math.max(at, current.updatedAt);
		const operation = { ...current.operations[index]!, state: "indeterminate" as const, updatedAt: timestamp };
		const next = PersistedAgentSchema.safeParse({
			...current,
			agentState: uncertainDeliveryState(operation.kind, current.agentState),
			operations: replaceAt(current.operations, index, operation),
			updatedAt: timestamp,
		});
		if (!next.success) return current;
		const applied = this.persistence.apply(owner, next.data);
		return inRecord(applied) ? applied.agent : current;
	}

	/** Stale-daemon operations become indeterminate. */
	abandonStaleOperations(
		owner: SessionRecord,
		agent: PersistedAgent,
		daemonInstanceId: string,
		at: number,
	): Application {
		const current = this.persistence.find(owner, agent.agentId);
		if (!current) return { disposition: "ignored", reason: "agent left the catalog" };
		const recovery = decideAgentRegisterRecovery(current, daemonInstanceId);
		if (recovery.staleOperationIds.length === 0)
			return { disposition: "ignored", reason: "agent has no operation from another daemon" };
		const staleIds = new Set(recovery.staleOperationIds);
		const timestamp = Math.max(at, current.updatedAt);
		const next = PersistedAgentSchema.safeParse({
			...current,
			agentState: recovery.nextAgentState,
			operations: current.operations.map((operation) =>
				staleIds.has(operation.operationId)
					? { ...operation, state: "indeterminate" as const, updatedAt: timestamp }
					: operation,
			),
			updatedAt: timestamp,
		});
		if (!next.success) return { disposition: "failed", reason: "stale operations did not produce a valid record" };
		return this.persistence.apply(owner, next.data);
	}

	takeRefusal(operationId: string): AgentRefusal | undefined {
		return this.applier.takeRefusal(operationId);
	}

	private operational(agent: PersistedAgent): boolean {
		return (
			agent.sessionId !== undefined &&
			agent.resolvedTarget !== undefined &&
			(agent.agentState === "idle" || agent.agentState === "working")
		);
	}

	private replay(
		owner: SessionRecord,
		operationId: string,
		identity: AgentOperationIdentity,
	): AgentTransition | null {
		return this.persistence.replay(owner, operationId, identity);
	}

	private catalog(owner: SessionRecord): AgentCatalog<PersistedAgent> {
		return this.persistence.read(owner);
	}

	/** Disk confirmation permits sending. */
	private commit(
		owner: SessionRecord,
		catalog: AgentCatalog<PersistedAgent>,
		agents: readonly PersistedAgent[],
		agent: PersistedAgent,
		operationId: string,
	): AgentTransition {
		const write = this.persistence.commit(owner, catalog, agents, agent, operationId);
		switch (write.kind) {
			case "landed":
				return write.transition;
			case "unconfirmed":
				// Abandon prevents stale resend.
				this.abandonDelivery(owner, agent.agentId, operationId, agent.updatedAt);
				throw new AgentTransitionError("persistence_failed", "transition was not confirmed on disk");
			case "conflict":
				throw new AgentTransitionError("persistence_failed", "catalog changed while saving");
			case "failed":
				throw new AgentTransitionError("persistence_failed", "transition could not be persisted", {
					cause: write.cause,
				});
			case "owner_missing":
				throw new AgentTransitionError("not_found", "managed session was not found");
		}
	}

	/** Whether `revision` is on disk; may try the write once. */
	confirmation(owner: SessionRecord, revision: number): CatalogConfirmation {
		return this.persistence.confirmation(owner, revision);
	}
}
