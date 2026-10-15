import type { CopilotPersistedAgent, CopilotStoredOperation } from "../shared/copilot-agent.js";
import type { CopilotCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import type { AgentApplication } from "./agentRelayCore.js";
import type { AgentTransitionErrorCode } from "./agentRouteEnvelope.js";
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
	prompt: string;
	target: unknown;
	model?: string;
	at: number;
}

export interface CopilotExistingAgentIntentInput {
	agentId: string;
	operationId: string;
	prompt: string;
	at: number;
}

export interface CopilotStopIntentInput {
	agentId: string;
	operationId: string;
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

export type CopilotTransitionErrorCode = AgentTransitionErrorCode;

export type CopilotApplication = AgentApplication<CopilotPersistedAgent>;

export class CopilotTransitionError extends Error {
	constructor(
		readonly code: CopilotTransitionErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CopilotTransitionError";
	}
}
