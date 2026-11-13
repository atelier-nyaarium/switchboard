import type { AgentBackendDescriptor } from "../shared/agent-backend.js";
import type { AgentExecutionTarget } from "../shared/agent-execution-target.js";
import type { AgentStoredOperation, PersistedAgent } from "../shared/agent-persisted.js";
import type { AgentServiceTier } from "../shared/agent-state.js";
import type { PersistedAgentCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import type { AgentTransitionResult } from "./agentCatalogPersistence.js";
import type { SessionAuthority } from "./sessionAuthority.js";

export interface AgentServiceDeps {
	backend: AgentBackendDescriptor;
	auth: SessionAuthority;
	sessionStore: SessionStore;
	offlineCatalog: ReadonlyMap<string, string>;
	catalogWriter: PersistedAgentCatalogWriter;
	/** Queues thread deletion at its origin and returns an undo. */
	threadEnded?: (agent: Pick<PersistedAgent, "sessionId" | "requestedTarget">) => (() => void) | undefined;
}

export interface AgentStartIntent {
	agentId: string;
	operationId: string;
	daemonInstanceId?: string;
	/** Workflow run owner. */
	runId?: string;
	prompt: string;
	/** Persisted target matches dispatch. */
	target: AgentExecutionTarget;
	model?: string;
	serviceTier?: AgentServiceTier;
	reasoningEffort?: string;
	outputSchema?: Record<string, unknown>;
	at: number;
}

export interface AgentMessageIntent {
	agentId: string;
	operationId: string;
	daemonInstanceId?: string;
	prompt: string;
	/** Absent preserves the tier. */
	serviceTier?: AgentServiceTier;
	outputSchema?: Record<string, unknown>;
	at: number;
}

export interface AgentStopIntent {
	agentId: string;
	operationId: string;
	daemonInstanceId?: string;
	at: number;
}

export interface OwnedAgent {
	owner: SessionRecord;
	agent: PersistedAgent;
}

/** Committed permits first dispatch. */
export type AgentTransition = AgentTransitionResult<PersistedAgent> & { operation: AgentStoredOperation };
