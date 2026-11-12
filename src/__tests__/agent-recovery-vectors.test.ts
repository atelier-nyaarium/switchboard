import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decideReconciliation } from "../gateway/agentApply.js";
import { decideAgentRegisterRecovery } from "../gateway/agentService.js";
import { decideCodexReconciliation } from "../gateway/codexAgentApply.js";
import { decideCodexRegisterRecovery } from "../gateway/codexAgentService.js";
import type { AgentFence } from "../shared/agent-fence.js";
import {
	type AgentReconciliationReport,
	type AgentRecoveryOperation,
	decideAgentReconciliation,
	decideRegisterRecovery,
} from "../shared/agent-recovery.js";

interface RegisterVector {
	name: string;
	liveDaemonInstanceId: string;
	agentState: string;
	operations: AgentRecoveryOperation[];
	expected: ReturnType<typeof decideRegisterRecovery>;
}

interface ReconcileVector {
	name: string;
	currentFence: AgentFence | null;
	receiptFence: AgentFence;
	knownActiveTurn?: string;
	report: AgentReconciliationReport;
	expected: ReturnType<typeof decideAgentReconciliation>;
}

const vectors = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "fixtures", "agent-recovery-vectors.json"), "utf8"),
) as { register: RegisterVector[]; reconcile: ReconcileVector[] };

describe("agent recovery decisions", () => {
	it.each(vectors.register.map((vector) => [vector.name, vector] as const))("register: %s", (_name, vector) => {
		const familyAgent = {
			agentState: vector.agentState,
			operations: vector.operations,
		};
		expect(decideRegisterRecovery(vector.agentState, vector.operations, vector.liveDaemonInstanceId)).toEqual(
			vector.expected,
		);
		expect(
			decideCodexRegisterRecovery(
				familyAgent as unknown as Parameters<typeof decideCodexRegisterRecovery>[0],
				vector.liveDaemonInstanceId,
			),
		).toEqual(vector.expected);
		expect(
			decideAgentRegisterRecovery(
				familyAgent as unknown as Parameters<typeof decideAgentRegisterRecovery>[0],
				vector.liveDaemonInstanceId,
			),
		).toEqual(vector.expected);
	});

	it.each(vectors.reconcile.map((vector) => [vector.name, vector] as const))("reconcile: %s", (_name, vector) => {
		const input = {
			currentFence: vector.currentFence ?? undefined,
			receiptFence: vector.receiptFence,
			knownActiveTurn: vector.knownActiveTurn,
			report: vector.report,
		};
		expect(decideAgentReconciliation(input)).toEqual(vector.expected);
		if ("family" in vector.report) {
			const agent = {
				fence: vector.currentFence ?? undefined,
				activeTurnId: vector.knownActiveTurn,
				turns: vector.knownActiveTurn ? [{ id: vector.knownActiveTurn, state: "inProgress" }] : [],
			};
			const receipt = {
				...vector.receiptFence,
				eventId: vector.receiptFence.lastEventId,
				turnId: vector.report.turnId,
				turnState: vector.report.turnState,
			};
			expect(
				decideCodexReconciliation(
					agent as unknown as Parameters<typeof decideCodexReconciliation>[0],
					receipt as Parameters<typeof decideCodexReconciliation>[1],
				),
			).toEqual(vector.expected);
		} else {
			const agent = {
				fence: vector.currentFence ?? undefined,
				activeTurnId: vector.knownActiveTurn,
				turns: vector.knownActiveTurn ? [{ id: vector.knownActiveTurn, state: "inProgress" as const }] : [],
			};
			const receipt = {
				...vector.receiptFence,
				eventId: vector.receiptFence.lastEventId,
				turnId: vector.report.turnId,
				turnState: vector.report.turnState,
			};
			expect(
				decideReconciliation(
					agent as Parameters<typeof decideReconciliation>[0],
					receipt as Parameters<typeof decideReconciliation>[1],
				),
			).toEqual(vector.expected);
		}
	});
});
