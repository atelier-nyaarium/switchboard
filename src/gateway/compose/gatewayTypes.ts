import type { Ambient } from "../../shared/ambient.js";
import type { SealedEnvelope } from "../../shared/crypto.js";
import type { RowEnvelope } from "../../shared/schemasInbox.js";
import type { SessionRecord } from "../../shared/session-store.js";
import type { Watcher } from "../assistant/watcher.js";
import type { KasaTransport } from "../devices/kasa/transport.js";
import type { RouterToolCallResult } from "../router/routerClient.js";
import type { RouterExchanger } from "../router/routerExchange.js";
import type { createWebSocketHandlers } from "../websocket.js";
import type { WorkflowEngineStartResult } from "../workflows/engine.js";
import type { WorkflowJournalRow, WorkflowRunRecord } from "../workflows/workflowSchemas.js";

export interface GatewayConfig {
	dataDir: string;
	federationDir: string;
	logDir: string;
	gatewayId: string;
	maxBlobStoreBytes: number;
	wakeTimeoutMs: number;
	hostWsToken?: string;
	routerBootstrapUrl: string | null;
}

export interface GatewayDeps {
	config: GatewayConfig;
	ambient: Ambient;
	/** Replaces the enrollment's road to the Router. */
	routerExchange?: RouterExchanger;
	allowFixtureIdentity?: boolean;
	/** The watchers' network door. */
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** Replaces the built-in watchers. */
	assistantWatchers?: readonly Watcher[];
	/** Replaces the Kasa transport. */
	kasaTransport?: KasaTransport;
	workflowProgressIntervalMsForTests?: number;
}

export interface PeerAddress {
	domainId: string;
	gatewayId: string;
}

export interface GatewayFaultPort {
	// Faults expose controlled test-only disruption hooks.
	dropRouterLink(): void;
	routerRegistered(): boolean;
	routerIncarnation(): number | null;
	heldEpochs(): number[];
	sessionRecord(team: string): SessionRecord | undefined;
	/** Runs the persist step's session sweep at this age. Answers the swept teams. */
	sweepSessions(ttlMs: number): string[];
	forgePeerRow(target: PeerAddress, address: string, envelope: RowEnvelope, op: unknown): Promise<unknown>;
	sealForPeer(target: PeerAddress, op: unknown): SealedEnvelope;
	routerCall(name: string, params: Record<string, unknown>): Promise<RouterToolCallResult>;
	routerInboxCall(name: string, params: Record<string, unknown>): Promise<RouterToolCallResult>;
	/** One routine sweep now, off the clock. */
	sweepRoutines(): Promise<void>;
	workflowStart(input: unknown): WorkflowEngineStartResult;
	workflowCancel(runId: string): boolean;
	workflowForgetSession(team: string): void;
	workflowRecord(runId: string): WorkflowRunRecord | null;
	workflowRows(runId: string): WorkflowJournalRow[];
	workflowAgents(team: string): Array<{
		family: "codex" | "copilot";
		agentId: string;
		runId?: string;
		state: string;
		activeTurnId?: string;
		operations: Array<{ operationId: string; kind: string; state: string; daemonInstanceId?: string }>;
		turns: Array<{ id: string; state: string }>;
	}>;
	/** Empty until a snapshot landed. */
	sharesHeld(): { revision: number; ready: boolean; sessionTargets: string[] };
	activateAgain(): void;
}

export interface GatewayGraph {
	router: (req: Request) => Promise<Response>;
	wsHandlers: ReturnType<typeof createWebSocketHandlers>;
	close: () => Promise<void>;
	faults: GatewayFaultPort;
}
