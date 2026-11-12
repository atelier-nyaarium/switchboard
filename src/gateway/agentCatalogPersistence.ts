import {
	type AgentOperationIdentity,
	type AgentReplayOperation,
	replaceAt,
	resolveAgentReplay,
} from "../shared/agent-record.js";
import { type AgentTurnMarks, collectTurns, notifyTurn } from "../shared/agent-turn-marks.js";
import type { AgentCatalogWriter, SessionRecord } from "../shared/session-store.js";
import type { AgentApplication } from "./agentRelayCore.js";
import { AgentTransitionError } from "./agentRouteEnvelope.js";

////////////////////////////////
//  Interfaces & Types

export interface AgentCatalogAgent {
	agentId: string;
	agentState: string;
	operations: readonly AgentReplayOperation[];
	turns: readonly { id: string; state: string }[];
	turnMarks?: AgentTurnMarks;
}

/** Collect result. */
export interface AgentCollection<TAgent> {
	agent: TAgent;
	turnIds: string[];
}

const MARK_ATTEMPTS = 3;

export type AgentCatalogRetirement =
	| { retired: true; catalogRevision: number }
	| {
			retired: false;
			reason: "not_found" | "active_turn" | "requested_operation" | "owner_missing" | "catalog_changed";
	  };

export interface AgentCatalog<TAgent> {
	version: 1;
	revision: number;
	agents: TAgent[];
}

/** Only `landed` guarantees disk. */
export type CatalogWrite<TAgent> =
	| { kind: "landed"; catalog: AgentCatalog<TAgent> }
	/** Record changed; disk write unconfirmed. */
	| { kind: "unconfirmed"; catalog: AgentCatalog<TAgent> }
	/** Revision moved; nothing changed. */
	| { kind: "conflict" }
	/** Nothing changed: write threw. */
	| { kind: "failed"; cause: unknown }
	| { kind: "owner_missing" };

export type CatalogConfirmation = "confirmed" | "pending" | "gone";

export type AgentCommit<TAgent extends AgentCatalogAgent> =
	| { kind: "landed"; transition: AgentTransitionResult<TAgent> }
	| Exclude<CatalogWrite<TAgent>, { kind: "landed" }>;

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

/** One owner's agent catalog for one backend. `write` is its only catalog write. */
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

	/** Whether `revision` is on disk; may try the write once. `gone`: the catalog no longer reaches it. */
	confirmation(owner: SessionRecord, revision: number): CatalogConfirmation {
		const current = this.family.read(owner)?.revision;
		// A live owner's revision never moves back.
		if (current === undefined || current < revision) return "gone";
		return this.durable(owner, current) ? "confirmed" : "pending";
	}

	private write(owner: SessionRecord, expectedRevision: number, agents: readonly TAgent[]): CatalogWrite<TAgent> {
		let result: ReturnType<AgentCatalogWriter<AgentCatalog<TAgent>, TAgent>["commit"]>;
		try {
			result = this.family.writer.commit(owner, expectedRevision, agents);
		} catch (cause) {
			return { kind: "failed", cause };
		}
		if (result.committed) return { kind: "landed", catalog: result.catalog };
		if (result.reason === "unconfirmed") return { kind: "unconfirmed", catalog: result.catalog };
		return result.reason === "owner_missing" ? { kind: "owner_missing" } : { kind: "conflict" };
	}

	commit(
		owner: SessionRecord,
		catalog: AgentCatalog<TAgent>,
		agents: readonly TAgent[],
		agent: TAgent,
		operationId: string,
	): AgentCommit<TAgent> {
		const write = this.write(owner, catalog.revision, agents);
		if (write.kind !== "landed") return write;
		const stored = write.catalog.agents.find((candidate) => candidate.agentId === agent.agentId)!;
		return {
			kind: "landed",
			transition: {
				owner,
				agent: stored,
				operation: stored.operations.find((candidate) => candidate.operationId === operationId)!,
				disposition: "committed",
				catalogRevision: write.catalog.revision,
			},
		};
	}

	apply(owner: SessionRecord, next: TAgent): AgentApplication<TAgent> {
		const catalog = this.read(owner);
		const index = this.matchOf(catalog, next.agentId);
		if (index === undefined) return { disposition: "ignored", reason: "agent left the catalog" };
		const write = this.write(owner, catalog.revision, replaceAt(catalog.agents, index, next));
		if (write.kind !== "landed" && write.kind !== "unconfirmed")
			return { disposition: "reconcile", owner, agent: next };
		const agent = write.catalog.agents.find((candidate) => candidate.agentId === next.agentId)!;
		return {
			disposition: write.kind === "landed" ? "applied" : "unconfirmed",
			owner,
			agent,
			catalogRevision: write.catalog.revision,
		};
	}

	/** Retries conflicts; undefined if retired. */
	private remark(
		owner: SessionRecord,
		agentId: string,
		marks: (agent: TAgent) => AgentTurnMarks | null,
		parse: (candidate: unknown) => TAgent,
	): TAgent | undefined {
		for (let attempt = 0; attempt < MARK_ATTEMPTS; attempt += 1) {
			const current = this.find(owner, agentId);
			if (!current) return undefined;
			const next = marks(current);
			if (!next) return current;
			const applied = this.apply(owner, parse({ ...current, turnMarks: next }));
			// Held marks make retries no-ops.
			if (applied.disposition === "applied" || applied.disposition === "unconfirmed") return applied.agent;
			if (applied.disposition === "ignored") return undefined;
		}
		throw new AgentTransitionError("persistence_failed", "catalog changed while saving");
	}

	collect(
		owner: SessionRecord,
		agentId: string,
		operationId: string | undefined,
		parse: (candidate: unknown) => TAgent,
	): AgentCollection<TAgent> | undefined {
		let turnIds: string[] = [];
		const agent = this.remark(
			owner,
			agentId,
			(current) => {
				const taken = collectTurns(current, operationId);
				turnIds = taken.turnIds;
				return taken.marks;
			},
			parse,
		);
		return agent ? { agent, turnIds } : undefined;
	}

	/** False on failure or retirement. */
	markNotified(
		owner: SessionRecord,
		agentId: string,
		turnId: string,
		parse: (candidate: unknown) => TAgent,
	): boolean {
		try {
			return this.remark(owner, agentId, (current) => notifyTurn(current, turnId), parse) !== undefined;
		} catch {
			return false;
		}
	}

	retire(owner: SessionRecord, agentId: string): AgentCatalogRetirement {
		const catalog = this.read(owner);
		const index = this.matchOf(catalog, agentId);
		if (index === undefined) return { retired: false, reason: "not_found" };
		const agent = catalog.agents[index]!;
		if (agent.turns.some((turn) => turn.state === "inProgress")) return { retired: false, reason: "active_turn" };
		if (agent.operations.some((operation) => operation.state === "requested"))
			return { retired: false, reason: "requested_operation" };
		const write = this.write(
			owner,
			catalog.revision,
			catalog.agents.filter((candidate) => candidate.agentId !== agentId),
		);
		// Unconfirmed drops count as retirement.
		if (write.kind === "landed" || write.kind === "unconfirmed") {
			return { retired: true, catalogRevision: write.catalog.revision };
		}
		return { retired: false, reason: write.kind === "owner_missing" ? "owner_missing" : "catalog_changed" };
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
