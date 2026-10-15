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
			applyEvent: (event, at) => deps.service.applyEvent(event, at),
			applyReceipt: (receipt, at) => deps.service.applyReceipt(receipt, at),
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
