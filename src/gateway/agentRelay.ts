import type { AgentBackendId } from "../shared/agent-backend.js";
import type { PersistedAgent } from "../shared/agent-persisted.js";
import { type AgentDaemonEvent, type AgentDaemonReceipt, agentWire } from "../shared/agent-wire.js";
import { type AgentCommandRequest, commandFor } from "./agentReducers.js";
import { AgentRelayCore, type AgentRelayDeps } from "./agentRelayCore.js";
import type { AgentService } from "./agentService.js";

export interface AgentRelayOptions extends AgentRelayDeps {
	backendId: AgentBackendId;
	service: AgentService;
}

export class AgentRelay extends AgentRelayCore<
	AgentDaemonEvent,
	AgentDaemonReceipt,
	AgentCommandRequest,
	PersistedAgent
> {
	constructor(deps: AgentRelayOptions) {
		const wire = agentWire(deps.backendId);
		super(deps, {
			backendId: deps.backendId,
			helloSchema: wire.hello,
			eventSchema: wire.event,
			receiptSchema: wire.receipt,
			commandSchema: wire.command,
			listAgents: (owner) => deps.service.listOwnedAgents(owner),
			fenceInstanceId: (agent) => agent.fence?.daemonInstanceId,
			targetId: (agent) => agent.resolvedTarget?.targetId,
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
			applyEvent: (event, at, held) => deps.service.applyEvent(event, at, held),
			applyReceipt: (receipt, at) => deps.service.applyReceipt(receipt, at),
			closeHeld: (ownerKey, agentId, report, at) => deps.service.closeHeld(ownerKey, agentId, report, at),
			abandonOperation: (ownerKey, agentId, operationId, at) =>
				deps.service.abandonOperation(ownerKey, agentId, operationId, at),
			reconciliationReport: (receipt) =>
				receipt.kind === "reconciled"
					? {
							...(receipt.turnId === undefined ? {} : { turnId: receipt.turnId }),
							...(receipt.turnState === undefined ? {} : { turnState: receipt.turnState }),
						}
					: undefined,
			confirmation: (owner, revision) => deps.service.confirmation(owner, revision),
			abandonStaleOperations: (owner, agent, daemonInstanceId, at) =>
				deps.service.abandonStaleOperations(owner, agent, daemonInstanceId, at),
			requestedOperations: (ownerKey, agent, daemonInstanceId) =>
				agent.operations.flatMap((operation) => {
					if (operation.state !== "requested" || operation.daemonInstanceId !== daemonInstanceId) return [];
					const command = commandFor(ownerKey, agent, operation);
					return command ? [command] : [];
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
