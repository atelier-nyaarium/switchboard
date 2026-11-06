import type { Ambient } from "../shared/ambient.js";
import type { CodexExecutionTarget, CodexPersistedAgent } from "../shared/codex-agent.js";
import { type CodexGatewayRequest, codexAgentIdForOperation } from "../shared/codex-agent.js";
import { isHostSpawn } from "../shared/host-spawn.js";
import type { SessionRecord } from "../shared/session-store.js";
import type { AgentCatalogRetirement } from "./agentCatalogPersistence.js";
import { AgentTransitionError } from "./agentRouteEnvelope.js";
import type { CodexAgentService } from "./codexAgentService.js";
import type { CodexTransitionResult } from "./codexAgentTypes.js";
import type { CodexRelay } from "./codexRelay.js";
import type { HostLivenessReader } from "./hostLiveness.js";

export type CodexStartCommandInput = Pick<
	Extract<CodexGatewayRequest, { kind: "start" }>,
	"operationId" | "prompt" | "cwd" | "model" | "serviceTier" | "outputSchema"
> & { runId?: string };
export type CodexMessageCommandInput = Pick<
	Extract<CodexGatewayRequest, { kind: "message" }>,
	"agentId" | "operationId" | "prompt" | "serviceTier" | "outputSchema"
>;
export type CodexStopCommandInput = Pick<Extract<CodexGatewayRequest, { kind: "stop" }>, "agentId" | "operationId">;

export type CodexDispatchResult =
	| { kind: "refused"; agentId: string; code: "daemon_unavailable" | "not_found"; reason: string }
	| { kind: "committed"; transition: CodexTransitionResult; dispatched: boolean };

export interface CodexAgentCommands {
	resolveTarget(owner: SessionRecord): CodexExecutionTarget | null;
	list(owner: SessionRecord): readonly CodexPersistedAgent[];
	start(owner: SessionRecord, input: CodexStartCommandInput): CodexDispatchResult;
	message(owner: SessionRecord, input: CodexMessageCommandInput): CodexDispatchResult;
	stop(owner: SessionRecord, input: CodexStopCommandInput): CodexDispatchResult;
	observe(
		owner: SessionRecord,
		agentId: string,
		operationId?: string,
	): { agent: CodexPersistedAgent | undefined; refusalReason?: string };
	abandon(owner: SessionRecord, agentId: string, operationId: string, at: number): CodexPersistedAgent | undefined;
	retire(owner: SessionRecord, agentId: string): AgentCatalogRetirement;
	retagRun(owner: SessionRecord, agentId: string, fromRunId: string, toRunId: string, at: number): boolean;
}

export function createCodexAgentCommands(deps: {
	service: CodexAgentService;
	relay: CodexRelay;
	readLiveness: HostLivenessReader;
	ambient: Pick<Ambient, "now">;
}): CodexAgentCommands {
	function targetAndDaemon(
		target?: CodexExecutionTarget,
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
			const agentId = codexAgentIdForOperation(input.operationId);
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
				outputSchema: input.outputSchema,
				target,
				model: input.model,
				serviceTier: input.serviceTier,
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
					model: input.model,
					...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
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
					reason: "codex agent was not found",
				};
			const transition = deps.service.beginMessage(owner, {
				agentId: input.agentId,
				operationId: input.operationId,
				daemonInstanceId: live.daemonInstanceId,
				prompt: input.prompt,
				outputSchema: input.outputSchema,
				serviceTier: input.serviceTier,
				at: deps.ambient.now(),
			});
			let dispatched = true;
			if (transition.disposition === "committed") {
				const agent = transition.agent;
				const model = agent.exchanges.find((exchange) => exchange.kind === "start")?.model;
				dispatched = deps.relay.dispatch({
					kind: "message",
					ownerKey: deps.service.ownerKeyOf(owner),
					agentId: input.agentId,
					operationId: input.operationId,
					target: agent.resolvedTarget!,
					threadId: agent.threadId!,
					expectedTurnId: transition.operation.expectedTurnId,
					prompt: input.prompt,
					...(agent.serviceTier === undefined ? {} : { serviceTier: agent.serviceTier }),
					...(model === undefined ? {} : { model }),
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
					reason: "codex agent was not found",
				};
			const transition = deps.service.beginStop(owner, {
				agentId: input.agentId,
				operationId: input.operationId,
				daemonInstanceId: live.daemonInstanceId,
				at: deps.ambient.now(),
			});
			let dispatched = true;
			if (transition.disposition === "committed" && !transition.operation.noOp) {
				dispatched = deps.relay.dispatch({
					kind: "interrupt",
					ownerKey: deps.service.ownerKeyOf(owner),
					agentId: input.agentId,
					operationId: input.operationId,
					target: transition.agent.resolvedTarget!,
					threadId: transition.agent.threadId!,
					turnId: transition.operation.turnId!,
				});
			}
			return { kind: "committed", transition, dispatched };
		},
		observe(owner, agentId, operationId) {
			const agent = deps.service.findOwnedAgent(owner, agentId);
			const refusalReason = operationId ? deps.service.takeRefusalReason(operationId) : undefined;
			return { agent, ...(refusalReason === undefined ? {} : { refusalReason }) };
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
