import {
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	CodexDaemonHelloSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
	type CodexPersistedAgent,
} from "../shared/codex-agent.js";
import { AgentRelayCore, type AgentRelayDeps } from "./agentRelayCore.js";
import type { CodexAgentService } from "./codexAgentService.js";

/** Preserve command discriminants. */
type CodexCommandRequest = CodexDaemonCommand extends infer Command
	? Command extends CodexDaemonCommand
		? Omit<Command, "type" | "requestId">
		: never
	: never;

export interface CodexRelayDeps extends AgentRelayDeps {
	service: CodexAgentService;
}

export class CodexRelay extends AgentRelayCore<
	CodexDaemonEvent,
	CodexDaemonReceipt,
	CodexCommandRequest,
	CodexPersistedAgent
> {
	constructor(deps: CodexRelayDeps) {
		super(deps, {
			backendId: "codex",
			helloSchema: CodexDaemonHelloSchema,
			eventSchema: CodexDaemonEventSchema,
			receiptSchema: CodexDaemonReceiptSchema,
			commandSchema: CodexDaemonCommandSchema,
			listAgents: (owner) => deps.sessionStore.listCodexAgents(owner),
			fenceInstanceId: (agent) => agent.fence?.daemonInstanceId,
			counterEvent: (event) =>
				event.kind === "counter"
					? {
							turnId: event.turnId,
							kind: event.counterKind,
							...(event.filesChanged === undefined ? {} : { filesChanged: event.filesChanged }),
						}
					: undefined,
			modelTurn: (receipt) =>
				receipt.kind === "accepted" && receipt.delivery !== "steered" ? receipt.turnId : undefined,
			applyEvent: (event, at) => deps.service.applyEvent(event, at),
			applyReceipt: (receipt, at) => deps.service.applyReceipt(receipt, at),
			abandonStaleOperations: (owner, agent, daemonInstanceId, at) =>
				deps.service.abandonStaleOperations(owner, agent, daemonInstanceId, at),
			requestedOperations: (ownerKey, agent, daemonInstanceId) => {
				const commands: CodexCommandRequest[] = [];
				for (const operation of agent.operations) {
					if (operation.state !== "requested" || operation.daemonInstanceId !== daemonInstanceId) continue;
					if (operation.kind === "stop") {
						if (!agent.resolvedTarget || !agent.threadId || !operation.turnId) continue;
						commands.push({
							kind: "interrupt",
							ownerKey,
							agentId: agent.agentId,
							operationId: operation.operationId,
							target: agent.resolvedTarget,
							threadId: agent.threadId,
							turnId: operation.turnId,
						});
						continue;
					}
					const exchange = agent.exchanges.find(
						(candidate) => candidate.operationId === operation.operationId,
					);
					if (!exchange) continue;
					if (operation.kind === "start") {
						commands.push({
							kind: "start",
							ownerKey,
							agentId: agent.agentId,
							operationId: operation.operationId,
							target: agent.requestedTarget,
							prompt: exchange.prompt,
							model: exchange.model,
							serviceTier: agent.serviceTier,
							outputSchema: exchange.outputSchema,
						});
					} else if (agent.resolvedTarget && agent.threadId) {
						commands.push({
							kind: "message",
							ownerKey,
							agentId: agent.agentId,
							operationId: operation.operationId,
							target: agent.resolvedTarget,
							threadId: agent.threadId,
							expectedTurnId: operation.expectedTurnId,
							prompt: exchange.prompt,
							model: agent.exchanges.find((candidate) => candidate.kind === "start")?.model,
							serviceTier: agent.serviceTier,
							outputSchema: exchange.outputSchema,
						});
					}
				}
				return commands;
			},
			reconcileRequest: (ownerKey, agent) =>
				agent.threadId && agent.resolvedTarget
					? {
							kind: "reconcile",
							ownerKey,
							agentId: agent.agentId,
							target: agent.resolvedTarget,
							threadId: agent.threadId,
							turnId: agent.activeTurnId,
						}
					: undefined,
		});
	}
}
