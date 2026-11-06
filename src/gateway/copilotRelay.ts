import {
	type CopilotDaemonCommand,
	CopilotDaemonCommandSchema,
	type CopilotDaemonEvent,
	CopilotDaemonEventSchema,
	CopilotDaemonHelloSchema,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
	type CopilotPersistedAgent,
} from "../shared/copilot-agent.js";
import { AgentRelayCore, type AgentRelayDeps } from "./agentRelayCore.js";
import type { CopilotAgentService } from "./copilotAgentService.js";

type CopilotCommandRequest = CopilotDaemonCommand extends infer Command
	? Command extends CopilotDaemonCommand
		? Omit<Command, "type" | "requestId">
		: never
	: never;

export interface CopilotRelayDeps extends AgentRelayDeps {
	service: CopilotAgentService;
}

export class CopilotRelay extends AgentRelayCore<
	CopilotDaemonEvent,
	CopilotDaemonReceipt,
	CopilotCommandRequest,
	CopilotPersistedAgent
> {
	constructor(deps: CopilotRelayDeps) {
		super(deps, {
			backendId: "copilot",
			helloSchema: CopilotDaemonHelloSchema,
			eventSchema: CopilotDaemonEventSchema,
			receiptSchema: CopilotDaemonReceiptSchema,
			commandSchema: CopilotDaemonCommandSchema,
			listAgents: (owner) => deps.service.listOwnedAgents(owner),
			fenceInstanceId: (agent) => agent.fence?.daemonInstanceId,
			counterEvent: (event) =>
				event.kind === "counter" ? { turnId: event.turnId, kind: event.counterKind } : undefined,
			modelTurn: (receipt) =>
				receipt.kind === "accepted" && receipt.delivery !== "steered" ? receipt.turnId : undefined,
			applyEvent: (event, at) => deps.service.applyEvent(event, at),
			applyReceipt: (receipt, at) => deps.service.applyReceipt(receipt, at),
			abandonStaleOperations: (owner, agent, daemonInstanceId, at) =>
				deps.service.abandonStaleOperations(owner, agent, daemonInstanceId, at),
			requestedOperations: (ownerKey, agent, daemonInstanceId) =>
				agent.operations.flatMap((operation): CopilotCommandRequest[] => {
					if (operation.state !== "requested" || operation.daemonInstanceId !== daemonInstanceId) return [];
					if (operation.kind === "start") {
						if (!operation.prompt) return [];
						return [
							{
								kind: "start",
								ownerKey,
								agentId: agent.agentId,
								operationId: operation.operationId,
								target: agent.requestedTarget,
								prompt: operation.prompt,
								model: operation.model,
								reasoningEffort: operation.reasoningEffort,
								outputSchema: operation.outputSchema,
							},
						];
					}
					if (!agent.resolvedTarget || !operation.sessionId) return [];
					if (operation.kind === "stop") {
						if (!operation.turnId) return [];
						return [
							{
								kind: "interrupt",
								ownerKey,
								agentId: agent.agentId,
								operationId: operation.operationId,
								target: agent.resolvedTarget,
								sessionId: operation.sessionId,
								turnId: operation.turnId,
							},
						];
					}
					if (!operation.prompt) return [];
					return [
						{
							kind: "message",
							ownerKey,
							agentId: agent.agentId,
							operationId: operation.operationId,
							target: agent.resolvedTarget,
							sessionId: operation.sessionId,
							expectedTurnId: operation.expectedTurnId,
							prompt: operation.prompt,
							outputSchema: operation.outputSchema,
						},
					];
				}),
			reconcileRequest: (ownerKey, agent) =>
				agent.sessionId && agent.resolvedTarget
					? {
							kind: "reconcile",
							ownerKey,
							agentId: agent.agentId,
							target: agent.resolvedTarget,
							sessionId: agent.sessionId,
							...(agent.activeTurnId ? { turnId: agent.activeTurnId } : {}),
						}
					: undefined,
		});
	}
}
