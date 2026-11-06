import type { CopilotPersistedAgent, CopilotStoredOperation } from "../shared/copilot-agent.js";
import type { CopilotCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import type { AgentApplication } from "./agentRelayCore.js";
import type { SessionAuthority } from "./sessionAuthority.js";

export interface CopilotAgentServiceDeps {
	auth: SessionAuthority;
	sessionStore: SessionStore;
	offlineCatalog: ReadonlyMap<string, string>;
	catalogWriter: CopilotCatalogWriter;
}

export interface CopilotIntentInput {
	agentId: string;
	operationId: string;
	daemonInstanceId?: string;
	runId?: string;
	prompt: string;
	target: unknown;
	model?: string;
	reasoningEffort?: string;
	outputSchema?: Record<string, unknown>;
	at: number;
}

export interface CopilotExistingAgentIntentInput {
	agentId: string;
	operationId: string;
	daemonInstanceId?: string;
	prompt: string;
	outputSchema?: Record<string, unknown>;
	at: number;
}

export interface CopilotStopIntentInput {
	agentId: string;
	operationId: string;
	daemonInstanceId?: string;
	at: number;
}

export interface OwnedCopilotAgent {
	owner: SessionRecord;
	agent: CopilotPersistedAgent;
}

export interface OwnedCopilotOperation extends OwnedCopilotAgent {
	operation: CopilotStoredOperation;
}

export interface CopilotTransitionResult extends OwnedCopilotOperation {
	disposition: "committed" | "replayed" | "indeterminate";
	catalogRevision: number;
}

export type CopilotApplication = AgentApplication<CopilotPersistedAgent>;
