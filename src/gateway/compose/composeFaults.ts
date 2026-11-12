// The fault port: the only way a test breaks or inspects a running gateway.

import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import { type RowEnvelope, signRowEnvelope } from "../../shared/schemasInbox.js";
import type { FederationSlice } from "../boot.js";
import type { PersistenceStage } from "./composePersistence.js";
import type { RoutineStage } from "./composeRoutines.js";
import type { SessionsStage } from "./composeSessions.js";
import type { WorkflowsStage } from "./composeWorkflows.js";
import type { FederationContext } from "./federationContext.js";
import type { GatewayFaultPort, PeerAddress } from "./gatewayTypes.js";

export interface FaultsStageDeps {
	context: FederationContext;
	sessions: Pick<SessionsStage, "sessionStore">;
	routines: Pick<RoutineStage, "reconcile">;
	workflows: Pick<WorkflowsStage, "engine" | "runner" | "forgetSession">;
	persistence: Pick<PersistenceStage, "sweepSessions">;
}

export function composeFaults({
	context,
	sessions,
	routines,
	workflows,
	persistence,
}: FaultsStageDeps): GatewayFaultPort {
	function federated(): FederationSlice {
		const slice = context.slice();
		if (!slice) throw new Error("this Gateway is not federated");
		return slice;
	}

	return {
		activateAgain: () => {
			const boot = context.boot();
			if (!boot) return;
			context.slice()?.routerClient.stop();
			context.standalone();
			context.activate(boot);
		},
		dropRouterLink: () => context.slice()?.routerClient.stop(),
		routerRegistered: () => context.slice()?.routerClient.isRegistered() ?? false,
		routerIncarnation: () => context.slice()?.routerClient.incarnation() ?? null,
		heldEpochs: () => context.contentKeys().epochs(),
		sessionRecord: (team) => sessions.sessionStore.getByTeam(team),
		sweepSessions: (ttlMs) => persistence.sweepSessions(ttlMs),
		forgePeerRow: async (target: PeerAddress, address: string, envelope: RowEnvelope, op: unknown) => {
			const slice = federated();
			const identity = context.boot();
			if (!identity) throw new Error("this Gateway holds no federation identity");
			const answer = await slice.routerClient.callInboxTool("inbox_append", {
				address,
				row: {
					envelope,
					producerSig: signRowEnvelope(envelope, identity.identity.sign.priv),
					body: slice.sealer.seal(target, op),
				},
				opKey: { ...envelope.opKey, hash: sha256Hex(canonicalJson({ address, op })) },
			});
			return answer.result;
		},
		sealForPeer: (target: PeerAddress, op: unknown) => federated().sealer.seal(target, op),
		routerCall: (name, params) => federated().routerClient.callTool(name, params),
		routerInboxCall: (name, params) => federated().routerClient.callInboxTool(name, params),
		sweepRoutines: () => routines.reconcile(),
		workflowStart: (input) => workflows.engine.startRun(input),
		workflowCancel: (runId) => workflows.engine.cancel(runId),
		workflowForgetSession: (team) => workflows.forgetSession(team),
		workflowRecord: (runId) => workflows.runner.get(runId),
		workflowRows: (runId) => workflows.runner.rows(runId),
		workflowAgents: (team) => {
			const owner = sessions.sessionStore.getByTeam(team);
			if (!owner) return [];
			return sessions.sessionStore.everyAgent(owner).map(({ backend, agent }) => ({
				backend,
				agentId: agent.agentId,
				...(agent.runId === undefined ? {} : { runId: agent.runId }),
				state: agent.agentState,
				...(agent.activeTurnId === undefined ? {} : { activeTurnId: agent.activeTurnId }),
				operations: agent.operations.map((operation) => ({
					operationId: operation.operationId,
					kind: operation.kind,
					state: operation.state,
					...(operation.daemonInstanceId === undefined
						? {}
						: { daemonInstanceId: operation.daemonInstanceId }),
				})),
				turns: agent.turns.map((turn) => ({ id: turn.id, state: turn.state })),
			}));
		},
		sharesHeld: () => {
			const shares = federated().shareState;
			return {
				revision: shares.revision(),
				ready: shares.isReady(),
				sessionTargets: shares.all().map((share) => share.sessionTarget),
			};
		},
	};
}
