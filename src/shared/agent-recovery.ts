import { type AgentFence, classifyReconciliationFence } from "./agent-fence.js";

export type AgentOperationKind = "start" | "message" | "stop";

export interface AgentRecoveryOperation {
	operationId: string;
	daemonInstanceId?: string;
	kind: AgentOperationKind;
	state: string;
}

export interface RegisterRecoveryDecision {
	staleOperationIds: string[];
	nextAgentState?: string;
}

/** Missing state means unknown. */
export type AgentReconciliationReport = { turnId?: string; turnState?: string };

export type AgentReconciliationDecision =
	| { kind: "duplicate" | "stale" | "askAgain" | "idle" }
	| { kind: "survives" | "recovering"; turnId: string }
	| { kind: "lost"; turnId: string; adoptTurnId?: string }
	| { kind: "adopt"; turnId: string };

export function decideRegisterRecovery(
	currentAgentState: string,
	operations: readonly AgentRecoveryOperation[],
	liveDaemonInstanceId: string,
): RegisterRecoveryDecision {
	// One with no daemon named can be neither resent nor answered.
	const stale = operations.filter(
		(operation) => operation.state === "requested" && operation.daemonInstanceId !== liveDaemonInstanceId,
	);
	return {
		staleOperationIds: stale.map((operation) => operation.operationId),
		nextAgentState: stale.some((operation) => operation.kind === "start")
			? "unavailable"
			: stale.some((operation) => operation.kind === "message")
				? "recovering"
				: currentAgentState,
	};
}

export function decideAgentReconciliation(input: {
	currentFence?: AgentFence;
	receiptFence: AgentFence;
	knownActiveTurn?: string;
	report: AgentReconciliationReport;
}): AgentReconciliationDecision {
	const fencePosition = classifyReconciliationFence(input.currentFence, input.receiptFence);
	if (fencePosition === "duplicate") return { kind: "duplicate" };
	if (fencePosition === "stale") return { kind: "stale" };

	const changedProcess =
		input.currentFence !== undefined &&
		(input.currentFence.daemonInstanceId !== input.receiptFence.daemonInstanceId ||
			input.currentFence.targetId !== input.receiptFence.targetId ||
			input.currentFence.generation !== input.receiptFence.generation);
	const knownActiveTurn = input.knownActiveTurn;

	const reportedActiveTurn = input.report.turnState === "inProgress" ? input.report.turnId : undefined;
	if (knownActiveTurn && reportedActiveTurn && knownActiveTurn !== reportedActiveTurn) {
		return changedProcess
			? { kind: "lost", turnId: knownActiveTurn, adoptTurnId: reportedActiveTurn }
			: { kind: "askAgain" };
	}
	if (knownActiveTurn && reportedActiveTurn === knownActiveTurn) {
		return { kind: "survives", turnId: knownActiveTurn };
	}
	if (knownActiveTurn) {
		// Settled reports precede terminal events.
		return changedProcess && input.report.turnState === undefined
			? { kind: "lost", turnId: knownActiveTurn }
			: { kind: "recovering", turnId: knownActiveTurn };
	}
	return reportedActiveTurn ? { kind: "adopt", turnId: reportedActiveTurn } : { kind: "idle" };
}
