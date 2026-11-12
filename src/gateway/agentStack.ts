import type { AgentBackendDescriptor, AgentBackendId } from "../shared/agent-backend.js";
import type { AgentProgressCounts } from "../shared/agent-counter.js";
import type { AgentExecutionTarget } from "../shared/agent-execution-target.js";
import type { PersistedAgent } from "../shared/agent-persisted.js";
import type { Ambient } from "../shared/ambient.js";
import { HostAgentModelsResultSchema, type HostOp, type HostOpResult } from "../shared/host-op.js";
import type { SessionRecord, SessionStore } from "../shared/session-store.js";
import type { AgentRefusal } from "./agentApply.js";
import type { AgentCatalogRetirement } from "./agentCatalogPersistence.js";
import {
	type AgentMessageCommand,
	type AgentStartCommand,
	type AgentStopCommand,
	createAgentCommands,
} from "./agentCommands.js";
import { AgentRelay } from "./agentRelay.js";
import { AgentRoute } from "./agentRoute.js";
import { AgentService } from "./agentService.js";
import type { AgentServiceDeps } from "./agentTypes.js";
import type { HostLivenessReader } from "./hostLiveness.js";

////////////////////////////////
//  Interfaces & Types

export type StackAgent = PersistedAgent;

export type StackDispatch =
	| { kind: "refused"; agentId: string; code: "daemon_unavailable" | "not_found"; reason: string }
	/** False means daemon unreachable. */
	| { kind: "committed"; agentId: string; dispatched: boolean };

export interface AgentStackRelay {
	handleHostMessage(raw: Record<string, unknown>): Promise<void>;
	onHostRegister(): Promise<void>;
	resendRequested(daemonInstanceId: string | undefined): Promise<void>;
	reconcileStale(owner: SessionRecord): void;
	onAgentChange(ownerKey: string, agentId: string, listener: () => void): () => void;
	progressCounts(ownerKey: string, agentId: string, turnId: string): AgentProgressCounts | undefined;
	progressForRun(runId: string): AgentProgressCounts;
}

export interface AgentStack {
	readonly backend: AgentBackendDescriptor;
	readonly relay: AgentStackRelay;
	route(req: Request, body: unknown): Promise<Response>;
	resolveTarget(owner: SessionRecord): AgentExecutionTarget | null;
	list(owner: SessionRecord): readonly StackAgent[];
	start(owner: SessionRecord, input: AgentStartCommand): StackDispatch;
	message(owner: SessionRecord, input: AgentMessageCommand): StackDispatch;
	stop(owner: SessionRecord, input: AgentStopCommand): StackDispatch;
	observe(
		owner: SessionRecord,
		agentId: string,
		operationId?: string,
	): { agent: StackAgent | undefined; refusal?: AgentRefusal };
	abandon(owner: SessionRecord, agentId: string, operationId: string, at: number): void;
	retire(owner: SessionRecord, agentId: string): AgentCatalogRetirement;
	retagRun(owner: SessionRecord, agentId: string, fromRunId: string, toRunId: string, at: number): boolean;
	markTurnNotified(owner: SessionRecord, agentId: string, turnId: string): boolean;
}

export type AgentStacks = ReadonlyMap<AgentBackendId, AgentStack>;

export interface AgentStackDeps {
	sessionStore: SessionStore;
	readLiveness: HostLivenessReader;
	sendToHost: (message: Record<string, unknown>) => boolean;
	ambient: Ambient;
	onCollected: (backend: AgentBackendId, ownerKey: string, agentId: string, turnIds: readonly string[]) => void;
	relayToHost: (op: HostOp) => Promise<HostOpResult>;
}

////////////////////////////////
//  Functions & Helpers

export function createAgentStack(deps: AgentStackDeps & Omit<AgentServiceDeps, "sessionStore">): AgentStack {
	const { backend, ambient, sessionStore } = deps;
	const service = new AgentService({ ...deps, sessionStore });
	const relay = new AgentRelay({
		backendId: backend.id,
		service,
		sessionStore,
		liveDaemonInstanceId: () => deps.readLiveness().daemonInstanceId,
		sendToHost: deps.sendToHost,
		ambient,
	});
	const commands = createAgentCommands({ backend, service, relay, readLiveness: deps.readLiveness, ambient });
	const route = new AgentRoute({
		backend,
		service,
		relay,
		commands,
		ambient,
		onCollected: (ownerKey, agentId, turnIds) => deps.onCollected(backend.id, ownerKey, agentId, turnIds),
		listModels: async (target) => {
			const answer = await deps.relayToHost({ kind: "agentModels", backend: backend.id, target });
			if (!answer.ok) return { kind: "unreachable" };
			const listed = HostAgentModelsResultSchema.safeParse(answer.result);
			return listed.success ? listed.data : { kind: "refused", reason: "the daemon's answer was unreadable" };
		},
	});
	const dispatched = (result: ReturnType<typeof commands.start>): StackDispatch =>
		result.kind === "refused"
			? result
			: { kind: "committed", agentId: result.transition.agent.agentId, dispatched: result.dispatched };
	return {
		backend,
		relay,
		route: (req, body) => route.handle(req, body),
		resolveTarget: (owner) => commands.resolveTarget(owner),
		list: (owner) => commands.list(owner),
		start: (owner, input) => dispatched(commands.start(owner, input)),
		message: (owner, input) => dispatched(commands.message(owner, input)),
		stop: (owner, input) => dispatched(commands.stop(owner, input)),
		observe: (owner, agentId, operationId) => commands.observe(owner, agentId, operationId),
		abandon: (owner, agentId, operationId, at) => {
			commands.abandon(owner, agentId, operationId, at);
		},
		retire: (owner, agentId) => commands.retire(owner, agentId),
		retagRun: (owner, agentId, fromRunId, toRunId, at) => commands.retagRun(owner, agentId, fromRunId, toRunId, at),
		markTurnNotified: (owner, agentId, turnId) => service.markTurnNotified(owner, agentId, turnId),
	};
}
