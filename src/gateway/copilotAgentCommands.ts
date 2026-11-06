import type { Ambient } from "../shared/ambient.js";
import type { CopilotDaemonFailureCode, CopilotPersistedAgent } from "../shared/copilot-agent.js";
import { type CopilotGatewayRequest, copilotAgentIdForOperation } from "../shared/copilot-agent.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import type { SessionRecord } from "../shared/session-store.js";
import type { AgentCatalogRetirement } from "./agentCatalogPersistence.js";
import { AgentTransitionError } from "./agentRouteEnvelope.js";
import type { CopilotAgentService } from "./copilotAgentService.js";
import type { CopilotTransitionResult } from "./copilotAgentTypes.js";
import type { CopilotRelay } from "./copilotRelay.js";
import type { HostLivenessReader } from "./hostLiveness.js";

export type CopilotStartCommandInput = Pick<
	Extract<CopilotGatewayRequest, { kind: "start" }>,
	"operationId" | "prompt" | "cwd" | "model" | "reasoningEffort" | "outputSchema"
> & { runId?: string };
export type CopilotMessageCommandInput = Pick<
	Extract<CopilotGatewayRequest, { kind: "message" }>,
	"agentId" | "operationId" | "prompt" | "outputSchema"
>;
export type CopilotStopCommandInput = Pick<Extract<CopilotGatewayRequest, { kind: "stop" }>, "agentId" | "operationId">;

export type CopilotDispatchResult =
	| { kind: "refused"; agentId: string; code: "daemon_unavailable" | "not_found"; reason: string }
	| { kind: "committed"; transition: CopilotTransitionResult; dispatched: boolean };

export interface CopilotAgentCommands {
	resolveTarget(owner: SessionRecord): CopilotPersistedAgent["requestedTarget"] | null;
	list(owner: SessionRecord): readonly CopilotPersistedAgent[];
	start(owner: SessionRecord, input: CopilotStartCommandInput): CopilotDispatchResult;
	message(owner: SessionRecord, input: CopilotMessageCommandInput): CopilotDispatchResult;
	stop(owner: SessionRecord, input: CopilotStopCommandInput): CopilotDispatchResult;
	observe(
		owner: SessionRecord,
		agentId: string,
		operationId?: string,
	): { agent: CopilotPersistedAgent | undefined; refusal?: { code?: CopilotDaemonFailureCode; message: string } };
	abandon(owner: SessionRecord, agentId: string, operationId: string, at: number): CopilotPersistedAgent | undefined;
	retire(owner: SessionRecord, agentId: string): AgentCatalogRetirement;
	retagRun(owner: SessionRecord, agentId: string, fromRunId: string, toRunId: string, at: number): boolean;
}

export function createCopilotAgentCommands(deps: {
	service: CopilotAgentService;
	relay: CopilotRelay;
	readLiveness: HostLivenessReader;
	ambient: Pick<Ambient, "now">;
}): CopilotAgentCommands {
	function targetAndDaemon(
		target?: CopilotPersistedAgent["requestedTarget"],
		requireContainer = false,
	): { daemonInstanceId: string } | { reason: string } {
		const live = deps.readLiveness();
		if (!live.socket || !live.daemonInstanceId) return { reason: "host daemon identity is unavailable" };
		if (requireContainer && target?.kind === "devcontainer" && !live.containerInCatalog(target))
			return { reason: "container target is not in the host catalog" };
		return { daemonInstanceId: live.daemonInstanceId };
	}

	return {
		resolveTarget(owner) {
			return deps.service.resolveExecutionTarget(owner);
		},
		list(owner) {
			return deps.service.listOwnedAgents(owner);
		},
		start(owner, input) {
			const agentId = copilotAgentIdForOperation(input.operationId);
			if (input.cwd !== undefined && !isHostSpawn(owner.spawn)) {
				throw new AgentTransitionError("invalid_input", "cwd applies to host sessions only");
			}
			const target = deps.service.resolveExecutionTarget(owner, input.cwd);
			if (!target)
				return {
					kind: "refused",
					agentId,
					code: "daemon_unavailable",
					reason: "no trusted execution target for this session",
				};
			const live = targetAndDaemon(target, true);
			if ("reason" in live) return { kind: "refused", agentId, code: "daemon_unavailable", reason: live.reason };
			const transition = deps.service.beginStart(owner, {
				agentId,
				operationId: input.operationId,
				daemonInstanceId: live.daemonInstanceId,
				prompt: input.prompt,
				target,
				model: input.model,
				reasoningEffort: input.reasoningEffort,
				outputSchema: input.outputSchema,
				runId: input.runId,
				at: deps.ambient.now(),
			});
			let dispatched = true;
			if (transition.disposition === "committed") {
				dispatched = deps.relay.dispatch({
					kind: "start",
					ownerKey: deps.service.ownerKeyOf(owner),
					agentId,
					operationId: input.operationId,
					target,
					prompt: input.prompt,
					...(input.model ? { model: input.model } : {}),
					...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
					...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
				});
			}
			return { kind: "committed", transition, dispatched };
		},
		message(owner, input) {
			const live = targetAndDaemon();
			if ("reason" in live)
				return { kind: "refused", agentId: input.agentId, code: "daemon_unavailable", reason: live.reason };
			const current = deps.service.findOwnedAgent(owner, input.agentId);
			const target = current?.requestedTarget;
			if (!target)
				return {
					kind: "refused",
					agentId: input.agentId,
					code: "not_found",
					reason: "Copilot agent was not found",
				};
			const transition = deps.service.beginMessage(owner, {
				agentId: input.agentId,
				operationId: input.operationId,
				daemonInstanceId: live.daemonInstanceId,
				prompt: input.prompt,
				outputSchema: input.outputSchema,
				at: deps.ambient.now(),
			});
			let dispatched = true;
			if (transition.disposition === "committed") {
				const agent = transition.agent;
				dispatched = deps.relay.dispatch({
					kind: "message",
					ownerKey: deps.service.ownerKeyOf(owner),
					agentId: input.agentId,
					operationId: input.operationId,
					target: agent.resolvedTarget!,
					sessionId: agent.sessionId!,
					prompt: input.prompt,
					...(transition.operation.expectedTurnId
						? { expectedTurnId: transition.operation.expectedTurnId }
						: {}),
					...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
				});
			}
			return { kind: "committed", transition, dispatched };
		},
		stop(owner, input) {
			const live = targetAndDaemon();
			if ("reason" in live)
				return { kind: "refused", agentId: input.agentId, code: "daemon_unavailable", reason: live.reason };
			const current = deps.service.findOwnedAgent(owner, input.agentId);
			const target = current?.requestedTarget;
			if (!target)
				return {
					kind: "refused",
					agentId: input.agentId,
					code: "not_found",
					reason: "Copilot agent was not found",
				};
			const transition = deps.service.beginStop(owner, {
				agentId: input.agentId,
				operationId: input.operationId,
				daemonInstanceId: live.daemonInstanceId,
				at: deps.ambient.now(),
			});
			let dispatched = true;
			if (transition.disposition === "committed" && transition.operation.state === "requested") {
				dispatched = deps.relay.dispatch({
					kind: "interrupt",
					ownerKey: deps.service.ownerKeyOf(owner),
					agentId: input.agentId,
					operationId: input.operationId,
					target: transition.agent.resolvedTarget!,
					sessionId: transition.agent.sessionId!,
					turnId: transition.operation.turnId!,
				});
			}
			return { kind: "committed", transition, dispatched };
		},
		observe(owner, agentId, operationId) {
			const agent = deps.service.findOwnedAgent(owner, agentId);
			const refusal = operationId ? deps.service.takeRefusal(operationId) : undefined;
			return { agent, ...(refusal === undefined ? {} : { refusal }) };
		},
		abandon(owner, agentId, operationId, at) {
			return deps.service.abandonDelivery(owner, agentId, operationId, at);
		},
		retire(owner, agentId) {
			return deps.service.retire(owner, agentId);
		},
		retagRun(owner, agentId, fromRunId, toRunId, at) {
			return deps.service.retagRunId(owner, agentId, fromRunId, toRunId, at);
		},
	};
}
