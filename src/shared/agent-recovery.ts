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

export type AgentReconciliationReport =
	| { family: "codex"; turnId?: string; turnState?: string }
	| { family: "copilot"; active: boolean; turnId?: string };

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
	const stale = operations.filter(
		(operation) =>
			operation.state === "requested" &&
			operation.daemonInstanceId !== undefined &&
			operation.daemonInstanceId !== liveDaemonInstanceId,
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

	if (input.report.family === "codex") {
		if (!knownActiveTurn) return { kind: "idle" };
		if (input.report.turnId === knownActiveTurn && input.report.turnState === "inProgress") {
			return { kind: "survives", turnId: knownActiveTurn };
		}
		if (changedProcess && (input.report.turnState === undefined || input.report.turnState === "inProgress")) {
			return { kind: "lost", turnId: knownActiveTurn };
		}
		return { kind: "recovering", turnId: knownActiveTurn };
	}

	const reportedActiveTurn = input.report.active && input.report.turnId ? input.report.turnId : undefined;
	if (knownActiveTurn && reportedActiveTurn && knownActiveTurn !== reportedActiveTurn) {
		return changedProcess
			? { kind: "lost", turnId: knownActiveTurn, adoptTurnId: reportedActiveTurn }
			: { kind: "askAgain" };
	}
	if (knownActiveTurn && reportedActiveTurn === knownActiveTurn) {
		return { kind: "survives", turnId: knownActiveTurn };
	}
	if (knownActiveTurn) {
		return changedProcess
			? { kind: "lost", turnId: knownActiveTurn }
			: { kind: "recovering", turnId: knownActiveTurn };
	}
	return reportedActiveTurn ? { kind: "adopt", turnId: reportedActiveTurn } : { kind: "idle" };
}
