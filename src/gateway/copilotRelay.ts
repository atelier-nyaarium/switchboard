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
			applyEvent: (event, at) => deps.service.applyEvent(event, at),
			applyReceipt: (receipt, at) => deps.service.applyReceipt(receipt, at),
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
