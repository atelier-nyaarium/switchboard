import { describe, expect, it } from "vitest";
import { restorePersistedAgentCatalog } from "../shared/agent-catalog.js";
import { agentOperationIdentity } from "../shared/agent-identity.js";
import { interruptingOperation } from "../shared/agent-persisted.js";
import { agentOperationFingerprintOf } from "../shared/agent-record.js";

const START = "123e4567-e89b-42d3-a456-426614174000";
const MESSAGE = "123e4567-e89b-42d3-a456-426614174001";
const STOP = "123e4567-e89b-42d3-a456-426614174002";
const CODEX_AGENT = `codex_${"a".repeat(32)}`;
const TARGET = { kind: "host", targetId: "host", cwd: "/home/dev" } as const;

function fence(lastEventId: number) {
	return { daemonInstanceId: "daemon-1", targetId: "host", generation: 1, lastEventId };
}

function fingerprint(kind: "start" | "message" | "stop", agentId: string, prompt?: string, model?: string) {
	return agentOperationFingerprintOf(agentOperationIdentity({ kind, agentId, prompt, model }));
}

/** An agent as Codex's own stack stored it, a shape no schema reads now: steered mid-turn, then asked to stop. */
function exchangeRecord() {
	return {
		version: 1,
		agentId: CODEX_AGENT,
		agentState: "working",
		requestedTarget: { kind: "host", workdirHint: "dev" },
		resolvedTarget: TARGET,
		threadId: "thread-1",
		activeTurnId: "turn-1",
		serviceTier: "priority",
		pendingInterrupt: { operationId: STOP, turnId: "turn-1", requestedAt: 40 },
		exchanges: [
			{
				exchangeId: START,
				operationId: START,
				kind: "start",
				prompt: "map the module",
				model: "gpt-6-luna",
				outputSchema: { type: "object" },
				status: "accepted",
				delivery: "started",
				turnId: "turn-1",
				createdAt: 10,
				acceptedAt: 20,
			},
			{
				exchangeId: MESSAGE,
				operationId: MESSAGE,
				kind: "message",
				prompt: "also the tests",
				status: "accepted",
				delivery: "steered",
				turnId: "turn-1",
				createdAt: 30,
				acceptedAt: 35,
			},
		],
		turns: [{ id: "turn-1", state: "inProgress", activities: [], updatedAt: 35 }],
		operations: [
			{
				operationId: START,
				daemonInstanceId: "daemon-1",
				kind: "start",
				fingerprint: fingerprint("start", CODEX_AGENT, "map the module", "gpt-6-luna"),
				state: "accepted",
				turnId: "turn-1",
				acceptanceFence: fence(1),
				preDispatch: { agentState: "creating" },
				createdAt: 10,
				updatedAt: 20,
			},
			{
				operationId: MESSAGE,
				kind: "message",
				fingerprint: fingerprint("message", CODEX_AGENT, "also the tests"),
				state: "accepted",
				turnId: "turn-1",
				expectedTurnId: "turn-1",
				acceptanceFence: fence(4),
				preDispatch: { agentState: "working", threadId: "thread-1", turnId: "turn-1", fence: fence(1) },
				createdAt: 30,
				updatedAt: 35,
			},
			{
				operationId: STOP,
				kind: "stop",
				fingerprint: fingerprint("stop", CODEX_AGENT),
				state: "requested",
				turnId: "turn-1",
				preDispatch: { agentState: "working", threadId: "thread-1", turnId: "turn-1", fence: fence(4) },
				createdAt: 40,
				updatedAt: 40,
			},
		],
		fence: fence(4),
		turnMarks: { collected: [], notified: [] },
		createdAt: 10,
		updatedAt: 40,
	};
}

describe("a stored agent catalog", () => {
	it("reads a record with exchanges and a thread as the one shape", () => {
		const restored = restorePersistedAgentCatalog({ version: 1, revision: 7, agents: [exchangeRecord()] });
		expect(restored?.revision).toBe(7);
		const agent = restored!.agents[0]!;
		expect(agent).toMatchObject({
			version: 2,
			agentId: CODEX_AGENT,
			agentState: "working",
			sessionId: "thread-1",
			activeTurnId: "turn-1",
			serviceTier: "priority",
			fence: fence(4),
		});
		expect(agent.operations).toEqual([
			{
				operationId: START,
				daemonInstanceId: "daemon-1",
				kind: "start",
				prompt: "map the module",
				model: "gpt-6-luna",
				outputSchema: { type: "object" },
				fingerprint: fingerprint("start", CODEX_AGENT, "map the module", "gpt-6-luna"),
				state: "accepted",
				turnId: "turn-1",
				sessionId: "thread-1",
				delivery: "started",
				createdAt: 10,
				updatedAt: 20,
			},
			{
				operationId: MESSAGE,
				kind: "message",
				prompt: "also the tests",
				expectedTurnId: "turn-1",
				fingerprint: fingerprint("message", CODEX_AGENT, "also the tests"),
				state: "accepted",
				turnId: "turn-1",
				sessionId: "thread-1",
				delivery: "steered",
				createdAt: 30,
				updatedAt: 35,
			},
			{
				operationId: STOP,
				kind: "stop",
				fingerprint: fingerprint("stop", CODEX_AGENT),
				state: "requested",
				turnId: "turn-1",
				sessionId: "thread-1",
				createdAt: 40,
				updatedAt: 40,
			},
		]);
		expect(agent).not.toHaveProperty("exchanges");
		expect(agent).not.toHaveProperty("threadId");
		expect(agent).not.toHaveProperty("pendingInterrupt");
		// The stop still in flight is read off its operation.
		expect(interruptingOperation(agent)?.operationId).toBe(STOP);
	});
});
