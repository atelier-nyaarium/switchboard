import type {
	CodexExecutionTarget,
	CodexPersistedAgent,
	CodexReconciliationFence,
	CodexResolvedTarget,
	CodexServiceTier,
	CodexStoredOperation,
} from "../shared/codex-agent.js";
import type { CodexCatalogWriter, SessionRecord, SessionStore } from "../shared/session-store.js";
import type { AgentApplication } from "./agentRelayCore.js";
import type { AgentTransitionErrorCode } from "./agentRouteEnvelope.js";
import type { SessionAuthority } from "./sessionAuthority.js";

////////////////////////////////
//  Interfaces & Types

export interface CodexAgentServiceDeps {
	auth: SessionAuthority;
	sessionStore: SessionStore;
	offlineCatalog: ReadonlyMap<string, string>;
	catalogWriter: CodexCatalogWriter;
}

export interface OwnedCodexAgent {
	owner: SessionRecord;
	agent: CodexPersistedAgent;
}

export interface OwnedCodexOperation extends OwnedCodexAgent {
	operation: CodexStoredOperation;
}

export interface CodexIntentInput {
	agentId: string;
	operationId: string;
	prompt: string;
	at: number;
}

export interface CodexStartIntentInput extends CodexIntentInput {
	/** Persisted and dispatched targets must match. */
	target: CodexExecutionTarget;
	/** Persist the model to detect changed retries. */
	model?: string;
	/** Persist the tier across resumes. */
	serviceTier?: CodexServiceTier;
}

export interface CodexExistingAgentIntentInput extends CodexIntentInput {
	agentId: string;
	/** Absent preserves the current tier. */
	serviceTier?: CodexServiceTier;
}

export interface CodexStopIntentInput {
	agentId: string;
	operationId: string;
	at: number;
}

export interface CodexDeliveryAcceptance {
	agentId: string;
	operationId: string;
	resolvedTarget: CodexResolvedTarget;
	threadId: string;
	turnId: string;
	delivery: "started" | "steered";
	fence: CodexReconciliationFence;
	at: number;
}

export interface CodexDaemonDeliveryAcceptance extends CodexDeliveryAcceptance {
	ownerKey: string;
}

export interface CodexTransitionResult extends OwnedCodexOperation {
	/** Only committed allows first dispatch; indeterminate awaits acceptance. */
	disposition: "committed" | "replayed" | "indeterminate";
	catalogRevision: number;
}

export interface CodexAcceptanceResult extends OwnedCodexOperation {
	disposition: "committed" | "replayed" | "indeterminate";
	catalogRevision: number;
	/** True holds acknowledgement pending reconciliation. */
	unresolved?: true;
}

export type CodexApplication = AgentApplication<CodexPersistedAgent>;

export type CodexTransitionErrorCode = AgentTransitionErrorCode;

////////////////////////////////
//  Class

export class CodexTransitionError extends Error {
	constructor(
		readonly code: CodexTransitionErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CodexTransitionError";
	}
}
