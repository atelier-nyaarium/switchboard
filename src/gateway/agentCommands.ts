import type { AgentBackendDescriptor } from "../shared/agent-backend.js";
import type { AgentExecutionTarget } from "../shared/agent-execution-target.js";
import type { PersistedAgent } from "../shared/agent-persisted.js";
import { agentIdForOperation } from "../shared/agent-record.js";
import { AGENT_EXPIRED_REASON, type AgentGatewayRequest } from "../shared/agent-state.js";
import type { Ambient } from "../shared/ambient.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import type { SessionRecord } from "../shared/session-store.js";
import type { AgentRefusal } from "./agentApply.js";
import type { AgentCatalogRetirement } from "./agentCatalogPersistence.js";
import { commandFor } from "./agentReducers.js";
import type { AgentRelay } from "./agentRelay.js";
import { AgentTransitionError } from "./agentRouteEnvelope.js";
import type { AgentService } from "./agentService.js";
import type { AgentTransition } from "./agentTypes.js";
import type { HostLivenessReader } from "./hostLiveness.js";

////////////////////////////////
//  Interfaces & Types

type Request<Kind extends AgentGatewayRequest["kind"]> = Extract<AgentGatewayRequest, { kind: Kind }>;

export type AgentStartCommand = Pick<
	Request<"start">,
	"operationId" | "prompt" | "cwd" | "model" | "serviceTier" | "reasoningEffort" | "outputSchema"
> & { runId?: string };
export type AgentMessageCommand = Pick<
	Request<"message">,
	"agentId" | "operationId" | "prompt" | "serviceTier" | "outputSchema"
>;
export type AgentStopCommand = Pick<Request<"stop">, "agentId" | "operationId">;

export type AgentRefusedCode = "daemon_unavailable" | "expired";

export type AgentDispatchResult =
	| { kind: "refused"; agentId: string; code: AgentRefusedCode; reason: string }
	/** False means daemon unreachable. */
	| { kind: "committed"; transition: AgentTransition; dispatched: boolean };

export interface AgentCommands {
	readonly backend: AgentBackendDescriptor;
	resolveTarget(owner: SessionRecord): AgentExecutionTarget | null;
	list(owner: SessionRecord): readonly PersistedAgent[];
	start(owner: SessionRecord, input: AgentStartCommand): AgentDispatchResult;
	message(owner: SessionRecord, input: AgentMessageCommand): AgentDispatchResult;
	stop(owner: SessionRecord, input: AgentStopCommand): AgentDispatchResult;
	observe(
		owner: SessionRecord,
		agentId: string,
		operationId?: string,
	): { agent: PersistedAgent | undefined; refusal?: AgentRefusal };
	abandon(owner: SessionRecord, agentId: string, operationId: string, at: number): PersistedAgent | undefined;
	retire(owner: SessionRecord, agentId: string): AgentCatalogRetirement;
	retagRun(owner: SessionRecord, agentId: string, fromRunId: string, toRunId: string, at: number): boolean;
}

////////////////////////////////
//  Functions & Helpers

export function createAgentCommands(deps: {
	backend: AgentBackendDescriptor;
	service: AgentService;
	relay: AgentRelay;
	readLiveness: HostLivenessReader;
	ambient: Pick<Ambient, "now">;
}): AgentCommands {
	const { backend, service } = deps;

	function liveDaemon(target?: AgentExecutionTarget): { daemonInstanceId: string } | { reason: string } {
		const live = deps.readLiveness();
		if (!live.socket || !live.daemonInstanceId) return { reason: "host daemon identity is unavailable" };
		if (target?.kind === "devcontainer" && !live.containerInCatalog(target))
			return { reason: "container target is not in the host catalog" };
		return { daemonInstanceId: live.daemonInstanceId };
	}

	/** Persist before daemon dispatch. */
	function dispatch(owner: SessionRecord, transition: AgentTransition): AgentDispatchResult {
		if (transition.disposition !== "committed" || transition.operation.state !== "requested")
			return { kind: "committed", transition, dispatched: true };
		const command = commandFor(service.ownerKeyOf(owner), transition.agent, transition.operation);
		return { kind: "committed", transition, dispatched: command !== undefined && deps.relay.dispatch(command) };
	}

	/** Missing agents also read as expired. */
	function existing(
		owner: SessionRecord,
		agentId: string,
	): { daemonInstanceId: string } | Extract<AgentDispatchResult, { kind: "refused" }> {
		const agent = service.findOwnedAgent(owner, agentId);
		if (!agent || agent.expiredAt !== undefined)
			return { kind: "refused", agentId, code: "expired", reason: AGENT_EXPIRED_REASON };
		const live = liveDaemon();
		if ("reason" in live) return { kind: "refused", agentId, code: "daemon_unavailable", reason: live.reason };
		return live;
	}

	return {
		backend,
		resolveTarget(owner) {
			return service.resolveExecutionTarget(owner);
		},
		list(owner) {
			return service.listOwnedAgents(owner);
		},
		start(owner, input) {
			const agentId = agentIdForOperation(backend.id, input.operationId);
			if (input.cwd !== undefined && !isHostSpawn(owner.spawn))
				throw new AgentTransitionError("invalid_input", "cwd applies to host sessions only");
			const target = service.resolveExecutionTarget(owner, input.cwd);
			if (!target)
				return {
					kind: "refused",
					agentId,
					code: "daemon_unavailable",
					reason: "no trusted execution target for this session",
				};
			const live = liveDaemon(target);
			if ("reason" in live) return { kind: "refused", agentId, code: "daemon_unavailable", reason: live.reason };
			return dispatch(
				owner,
				service.beginStart(owner, {
					agentId,
					operationId: input.operationId,
					daemonInstanceId: live.daemonInstanceId,
					prompt: input.prompt,
					target,
					model: input.model,
					serviceTier: input.serviceTier,
					reasoningEffort: input.reasoningEffort,
					outputSchema: input.outputSchema,
					runId: input.runId,
					at: deps.ambient.now(),
				}),
			);
		},
		message(owner, input) {
			const live = existing(owner, input.agentId);
			if ("kind" in live) return live;
			return dispatch(
				owner,
				service.beginMessage(owner, {
					agentId: input.agentId,
					operationId: input.operationId,
					daemonInstanceId: live.daemonInstanceId,
					prompt: input.prompt,
					serviceTier: input.serviceTier,
					outputSchema: input.outputSchema,
					at: deps.ambient.now(),
				}),
			);
		},
		stop(owner, input) {
			const live = existing(owner, input.agentId);
			if ("kind" in live) return live;
			return dispatch(
				owner,
				service.beginStop(owner, {
					agentId: input.agentId,
					operationId: input.operationId,
					daemonInstanceId: live.daemonInstanceId,
					at: deps.ambient.now(),
				}),
			);
		},
		observe(owner, agentId, operationId) {
			const agent = service.findOwnedAgent(owner, agentId);
			const refusal = operationId ? service.takeRefusal(operationId) : undefined;
			return { agent, ...(refusal === undefined ? {} : { refusal }) };
		},
		abandon(owner, agentId, operationId, at) {
			return service.abandonDelivery(owner, agentId, operationId, at);
		},
		retire(owner, agentId) {
			return service.retire(owner, agentId);
		},
		retagRun(owner, agentId, fromRunId, toRunId, at) {
			return service.retagRunId(owner, agentId, fromRunId, toRunId, at);
		},
	};
}
