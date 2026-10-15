import {
	type AgentOperationIdentity,
	type AgentReplayOperation,
	replaceAt,
	resolveAgentReplay,
} from "../shared/agent-record.js";
import type { AgentCatalogWriter, SessionRecord } from "../shared/session-store.js";
import type { AgentApplication } from "./agentRelayCore.js";
import { AgentTransitionError } from "./agentRouteEnvelope.js";

////////////////////////////////
//  Interfaces & Types

export interface AgentCatalogAgent {
	agentId: string;
	operations: readonly AgentReplayOperation[];
}

export interface AgentCatalog<TAgent> {
	version: 1;
	revision: number;
	agents: TAgent[];
}

export interface AgentTransitionResult<TAgent extends AgentCatalogAgent> {
	owner: SessionRecord;
	agent: TAgent;
	operation: TAgent["operations"][number];
	/** Only `committed` authorizes first dispatch. */
	disposition: "committed" | "replayed" | "indeterminate";
	catalogRevision: number;
}

export interface AgentCatalogFamily<TAgent extends AgentCatalogAgent> {
	read(owner: SessionRecord): AgentCatalog<TAgent> | undefined;
	writer: AgentCatalogWriter<AgentCatalog<TAgent>, TAgent>;
}

////////////////////////////////
//  Class

/** Both families' agent catalog. */
export class AgentCatalogPersistence<TAgent extends AgentCatalogAgent> {
	constructor(private readonly family: AgentCatalogFamily<TAgent>) {}

	read(owner: SessionRecord): AgentCatalog<TAgent> {
		return this.family.read(owner) ?? { version: 1, revision: 0, agents: [] };
	}

	/** Exactly one match, or none. */
	find(owner: SessionRecord, agentId: string): TAgent | undefined {
		const catalog = this.read(owner);
		const index = this.matchOf(catalog, agentId);
		return index === undefined ? undefined : catalog.agents[index];
	}

	indexOf(catalog: AgentCatalog<TAgent>, agentId: string): number {
		const index = this.matchOf(catalog, agentId);
		if (index === undefined) throw new AgentTransitionError("not_found", "agent was not found");
		return index;
	}

	durable(owner: SessionRecord, revision: number): boolean {
		if (this.family.writer.isDurable(owner, revision)) return true;
		try {
			return this.family.writer.checkpoint(owner, revision).confirmed;
		} catch {
			return false;
		}
	}

	commit(
		owner: SessionRecord,
		catalog: AgentCatalog<TAgent>,
		agents: readonly TAgent[],
		agent: TAgent,
		operationId: string,
	): AgentTransitionResult<TAgent> {
		let committed: ReturnType<AgentCatalogWriter<AgentCatalog<TAgent>, TAgent>["commit"]>;
		try {
			committed = this.family.writer.commit(owner, catalog.revision, agents);
		} catch (error) {
			throw new AgentTransitionError("persistence_failed", "transition could not be persisted", { cause: error });
		}
		if (!committed.committed && committed.reason === "owner_missing") {
			throw new AgentTransitionError("not_found", "managed session was not found");
		}
		// A retry rereads the catalog.
		if (!committed.committed) throw new AgentTransitionError("persistence_failed", "catalog changed while saving");
		const stored = committed.catalog.agents.find((candidate) => candidate.agentId === agent.agentId)!;
		return {
			owner,
			agent: stored,
			operation: stored.operations.find((candidate) => candidate.operationId === operationId)!,
			disposition: "committed",
			catalogRevision: committed.catalog.revision,
		};
	}

	/** Unpersisted: reconcile, never acknowledge. */
	apply(owner: SessionRecord, next: TAgent): AgentApplication<TAgent> {
		const catalog = this.read(owner);
		const index = this.matchOf(catalog, next.agentId);
		if (index === undefined) return { disposition: "ignored", reason: "agent left the catalog" };
		let committed: ReturnType<AgentCatalogWriter<AgentCatalog<TAgent>, TAgent>["commit"]>;
		try {
			committed = this.family.writer.commit(owner, catalog.revision, replaceAt(catalog.agents, index, next));
		} catch {
			return { disposition: "reconcile", owner, agent: next };
		}
		if (!committed.committed) return { disposition: "reconcile", owner, agent: next };
		const agent = committed.catalog.agents.find((candidate) => candidate.agentId === next.agentId)!;
		return { disposition: "applied", owner, agent, catalogRevision: committed.catalog.revision };
	}

	replay(
		owner: SessionRecord,
		operationId: string,
		identity: AgentOperationIdentity,
	): AgentTransitionResult<TAgent> | null {
		const catalog = this.read(owner);
		const found = resolveAgentReplay(catalog.agents, operationId, identity, () =>
			this.durable(owner, catalog.revision),
		);
		if (found.kind === "none") return null;
		if (found.kind === "conflict") throw new AgentTransitionError("operation_conflict", found.reason);
		return {
			owner,
			agent: found.agent,
			operation: found.operation,
			disposition: found.replayable ? "replayed" : "indeterminate",
			catalogRevision: catalog.revision,
		};
	}

	private matchOf(catalog: AgentCatalog<TAgent>, agentId: string): number | undefined {
		const matches = catalog.agents.flatMap((agent, index) => (agent.agentId === agentId ? [index] : []));
		return matches.length === 1 ? matches[0] : undefined;
	}
}
