import { describe, expect, it } from "vitest";
import type { CodexAgentCommands } from "../gateway/codexAgentCommands.js";
import type { CodexRelay } from "../gateway/codexRelay.js";
import type { CopilotAgentCommands } from "../gateway/copilotAgentCommands.js";
import type { CopilotRelay } from "../gateway/copilotRelay.js";
import { createWebSocketHandlers } from "../gateway/websocket.js";
import { createWorkflowAgentDispatch } from "../gateway/workflows/agentDispatch.js";
import type { WorkflowDispatchOutcome, WorkflowIssuedCall } from "../gateway/workflows/engine.js";
import type { WorkflowRunner } from "../gateway/workflows/runner.js";
import { threadMapsOf, type WorkflowJournalRow, type WorkflowRunRecord } from "../gateway/workflows/workflowSchemas.js";
import type { TeamRegistry } from "../gateway/wsTypes.js";
import type { AgentExecutionTarget } from "../shared/agent-execution-target.js";
import type { Ambient } from "../shared/ambient.js";
import type { ClaudeTurnResultFrame, HostOp, HostOpResult } from "../shared/host-op.js";
import type { SessionRecord } from "../shared/session-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { createFakeSocket } from "../testing/fakeSocket.js";

const runId = "run-1";
const target: AgentExecutionTarget = { kind: "host", workdirHint: "/workspace/project" };
const owner: SessionRecord = {
	id: "session-1",
	sessionLabel: "Session",
	spawn: "host",
	harness: "claude",
	lastSeen: 1,
};

function waitFor(check: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		let attempts = 0;
		const poll = (): void => {
			if (check()) {
				resolve();
				return;
			}
			attempts += 1;
			if (attempts > 100) {
				reject(new Error("condition not reached"));
				return;
			}
			setTimeout(poll, 0);
		};
		poll();
	});
}

function callOf(issueOrdinal: number, options: WorkflowIssuedCall["options"] = {}): WorkflowIssuedCall {
	return {
		runId,
		team: "team-a",
		issueOrdinal,
		callHash: String(issueOrdinal).padStart(64, "a"),
		prompt: `step ${issueOrdinal}`,
		backend: "claude",
		options,
		threadMode: options.thread ? "message" : "start",
	};
}

function resultFor(
	turn: Extract<WorkflowJournalRow, { kind: "turn" }>,
	outcome: ClaudeTurnResultFrame["outcome"] = "completed",
	answer: ClaudeTurnResultFrame["answer"] = "42",
	reason: string | null = null,
): ClaudeTurnResultFrame {
	return {
		type: "claude_turn_result",
		runId,
		turnId: turn.turnId,
		sessionId: turn.agentId!,
		outcome,
		answer,
		reason,
	};
}

function setup(
	options: {
		instanceId?: string;
		agentsFile?:
			| { kind: "read"; text: string }
			| { kind: "refused"; code: "missing" | "non_regular" | "non_utf8" | "too_large" | "outside_target" };
		claudeFile?:
			| { kind: "read"; text: string }
			| { kind: "refused"; code: "missing" | "non_regular" | "non_utf8" | "too_large" | "outside_target" };
		runReplies?: HostOpResult[];
		cancelReplies?: HostOpResult[];
		beforeReadSkill?: () => Promise<void>;
	} = {},
) {
	const ambient = fakeAmbient({ seed: Buffer.alloc(32, 7), drive: "manual" });
	let instanceId = options.instanceId ?? "daemon-a";
	const socket = {};
	const record: WorkflowRunRecord = {
		runId,
		team: "team-a",
		startOperationId: "start-1",
		resumeFrom: null,
		script: "",
		args: {},
		defaultBackend: "claude",
		phases: [],
		status: "running",
		result: null,
		failureReason: null,
		notified: false,
		collected: false,
		createdAt: 1,
		settledAt: null,
	};
	const rows: WorkflowJournalRow[] = [];
	const runner = {
		append: (_id: string, row: WorkflowJournalRow) => {
			rows.push(row);
			return true;
		},
		rows: (_id: string) => rows,
		get: (_id: string) => record,
		runs: () => [record],
		running: () => [record],
	} as unknown as WorkflowRunner;
	const calls: HostOp[] = [];
	const snapshots: WorkflowJournalRow[][] = [];
	const replies = [...(options.runReplies ?? [])];
	const cancelReplies = [...(options.cancelReplies ?? [])];
	const relayToHost = async (op: HostOp): Promise<HostOpResult> => {
		calls.push(op);
		if (op.kind === "readSkill") {
			await options.beforeReadSkill?.();
			const reply = op.path === "AGENTS.md" ? options.agentsFile : options.claudeFile;
			return { ok: true, result: reply ?? { kind: "refused", code: "missing" } };
		}
		if (op.kind === "claudeRun") {
			snapshots.push([...rows]);
			return replies.shift() ?? { ok: true, result: { kind: "accepted" } };
		}
		return cancelReplies.shift() ?? { ok: true, result: { cancelled: true } };
	};
	const dispatch = createWorkflowAgentDispatch({
		sessionStore: {
			getByTeam: () => owner,
			list: () => [owner],
			teamOf: () => "team-a",
		} as never,
		ambient: ambient as Pick<Ambient, "now" | "newId">,
		runner,
		readLiveness: () => ({
			socket: socket as never,
			daemonInstanceId: instanceId,
			containerInCatalog: () => true,
		}),
		relayToHost,
		codex: { resolveTarget: () => target, list: () => [] } as unknown as CodexAgentCommands,
		copilot: { list: () => [] } as unknown as CopilotAgentCommands,
		codexRelay: {} as CodexRelay,
		copilotRelay: {} as CopilotRelay,
	});
	const outcomes: WorkflowDispatchOutcome[] = [];
	const eventOrder: string[] = [];
	const dispatchCall = (call: WorkflowIssuedCall): void => {
		rows.push({
			kind: "issue",
			issueOrdinal: call.issueOrdinal,
			callHash: call.callHash,
			prompt: call.prompt,
			resolvedBackend: call.backend,
			options: call.options,
		});
		dispatch.port.dispatch(call, (outcome) => {
			outcomes.push(outcome);
			rows.push({
				kind: "settle",
				settleOrdinal: rows.filter((row) => row.kind === "settle").length + 1,
				issueOrdinal: call.issueOrdinal,
				outcome: outcome.outcome,
				answer: outcome.answer,
				reason: outcome.reason,
				...(outcome.threadMap ? { threadMap: outcome.threadMap } : {}),
			});
			eventOrder.push("settle row");
			dispatch.port.settled?.(call, outcome);
			eventOrder.push("settled callback");
		});
	};
	return {
		ambient,
		calls,
		dispatch,
		dispatchCall,
		eventOrder,
		outcomes,
		record,
		rows,
		setInstanceId: (value: string) => (instanceId = value),
		snapshots,
	};
}

function latestTurn(rows: WorkflowJournalRow[], issueOrdinal: number): Extract<WorkflowJournalRow, { kind: "turn" }> {
	const turn = rows
		.filter(
			(row): row is Extract<WorkflowJournalRow, { kind: "turn" }> =>
				row.kind === "turn" && row.issueOrdinal === issueOrdinal,
		)
		.at(-1);
	if (!turn) throw new Error("turn row missing");
	return turn;
}

describe("Claude workflow dispatch", () => {
	it("journals a fresh turn that opens with the read-first line and no instruction text", async () => {
		const state = setup({ agentsFile: { kind: "refused", code: "too_large" } });
		state.dispatchCall(callOf(1));
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		const operation = state.calls.find((op) => op.kind === "claudeRun");
		if (operation?.kind !== "claudeRun") throw new Error("Claude run missing");
		const turn = latestTurn(state.rows, 1);
		expect(state.snapshots[0]?.some((row) => row.kind === "turn")).toBe(true);
		expect(operation.sessionId).toBe(turn.agentId);
		expect(operation.resume).toBe(false);
		expect(operation.appendSystemPrompt).toBeNull();
		expect(operation.prompt.startsWith("Read AGENTS.md first.\n\n")).toBe(true);
		expect(turn.prompt).toBe(operation.prompt);
		expect(state.rows.some((row) => row.kind === "skill_text")).toBe(false);
	});

	it("names CLAUDE.md only when AGENTS.md is missing", async () => {
		const state = setup({
			agentsFile: { kind: "refused", code: "missing" },
			claudeFile: { kind: "read", text: "Claude instructions" },
		});
		state.dispatchCall(callOf(1));
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		expect(
			state.calls.filter((op) => op.kind === "readSkill").map((op) => op.kind === "readSkill" && op.path),
		).toEqual(["AGENTS.md", "CLAUDE.md"]);
		const operation = state.calls.find((op) => op.kind === "claudeRun");
		if (operation?.kind !== "claudeRun") throw new Error("Claude run missing");
		expect(operation.prompt.startsWith("Read CLAUDE.md first.")).toBe(true);
	});

	it("adds no read-first line when both instruction files are missing", async () => {
		const state = setup();
		state.dispatchCall(callOf(1));
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		expect(state.calls.filter((op) => op.kind === "readSkill")).toHaveLength(2);
		const operation = state.calls.find((op) => op.kind === "claudeRun");
		if (operation?.kind !== "claudeRun") throw new Error("Claude run missing");
		expect(operation.prompt.startsWith("Read ")).toBe(false);
	});

	it("stamps a fresh turn with the live register after instruction reads", async () => {
		let startRead!: () => void;
		let finishRead!: () => void;
		const readStarted = new Promise<void>((resolve) => (startRead = resolve));
		const blockedRead = new Promise<void>((resolve) => (finishRead = resolve));
		const state = setup({
			agentsFile: { kind: "read", text: "Instructions" },
			beforeReadSkill: async () => {
				startRead();
				await blockedRead;
			},
		});
		state.dispatchCall(callOf(1));
		await readStarted;
		state.setInstanceId("daemon-b");
		finishRead();
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		expect(latestTurn(state.rows, 1).registerInstanceId).toBe("daemon-b");
	});

	it("settles before acknowledging and ignores duplicate results", async () => {
		const state = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		const call = callOf(1);
		state.dispatchCall(call);
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		const frame = resultFor(latestTurn(state.rows, 1));
		const socket = createFakeSocket();
		socket.ws.data.teamName = "host";
		socket.ws.data.subId = "daemon";
		const registry: TeamRegistry = new Map([["host", new Map([["daemon", socket.ws]])]]);
		const handlers = createWebSocketHandlers({
			ambient: state.ambient,
			registry,
			conversationRegistry: new Map(),
			knownTeamPaths: new Map(),
			offlineCatalog: new Map(),
			wakeCoordinator: {} as never,
			config: { HEARTBEAT_INTERVAL_MS: 30_000, MISSED_PINGS_LIMIT: 2 },
			onClaudeTurnResult: (result) => state.dispatch.claudeTurnResult(result),
		});
		socket.onFrame((sent) => {
			if (sent.type === "claude_turn_ack") state.eventOrder.push("acknowledged");
		});
		try {
			handlers.message(socket.ws, JSON.stringify(frame));
			await waitFor(() => socket.sent.length === 1);
			expect(socket.sent[0]).toEqual({ type: "claude_turn_ack", runId, turnId: frame.turnId });
			expect(state.eventOrder).toEqual(["settle row", "settled callback", "acknowledged"]);
			expect(state.outcomes[0]).toMatchObject({ outcome: "completed", answer: 42 });
			const rowCount = state.rows.length;
			handlers.message(socket.ws, JSON.stringify(frame));
			await waitFor(() => socket.sent.length === 2);
			expect(state.rows).toHaveLength(rowCount);
			expect(state.outcomes).toHaveLength(1);
		} finally {
			state.ambient.clearInterval(handlers.heartbeatInterval);
		}
	});

	it("resumes the mapped uuid on later thread calls", async () => {
		const state = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		const first = callOf(1, { thread: "implementer" });
		state.dispatchCall(first);
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		await state.dispatch.claudeTurnResult(resultFor(latestTurn(state.rows, 1)));
		const mapping = threadMapsOf(state.rows)[0];
		if (!mapping) throw new Error("thread mapping missing");
		const second = callOf(2, { thread: "implementer" });
		state.dispatchCall(second);
		await waitFor(() => state.calls.filter((op) => op.kind === "claudeRun").length === 2);
		const operation = state.calls.filter((op) => op.kind === "claudeRun")[1];
		expect(operation).toMatchObject({ sessionId: mapping.agentId, resume: true });
	});

	it("switches a missing thread session once", async () => {
		const state = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		state.dispatchCall(callOf(1, { thread: "implementer" }));
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		const firstTurn = latestTurn(state.rows, 1);
		const completion = state.dispatch.claudeTurnResult(
			resultFor(firstTurn, "sessionMissing", null, "No conversation found"),
		);
		await waitFor(() => state.calls.filter((op) => op.kind === "claudeRun").length === 2);
		const turns = state.rows.filter(
			(row): row is Extract<WorkflowJournalRow, { kind: "turn" }> => row.kind === "turn",
		);
		expect(turns[1]?.agentId).not.toBe(firstTurn.agentId);
		expect(state.calls.filter((op) => op.kind === "claudeRun")[1]).toMatchObject({
			sessionId: turns[1]?.agentId,
			resume: false,
		});
		await state.dispatch.claudeTurnResult(resultFor(turns[1]!, "sessionMissing", null, "No conversation found"));
		await completion;
		expect(state.outcomes).toHaveLength(1);
		expect(state.outcomes[0]).toMatchObject({ outcome: "failed", reason: "No conversation found" });
		expect(state.calls.filter((op) => op.kind === "claudeRun")).toHaveLength(2);
	});

	it("waits for a tick after busy", async () => {
		const state = setup({
			agentsFile: { kind: "read", text: "Instructions" },
			runReplies: [
				{ ok: true, result: { kind: "refused", code: "busy" } },
				{ ok: true, result: { kind: "accepted" } },
			],
		});
		state.dispatchCall(callOf(1));
		await waitFor(() => state.calls.filter((op) => op.kind === "claudeRun").length === 1);
		state.dispatch.port.tick?.();
		await waitFor(() => state.calls.filter((op) => op.kind === "claudeRun").length === 2);
		expect(state.calls.filter((op) => op.kind === "claudeRun")[1]).toMatchObject({
			turnId: latestTurn(state.rows, 1).turnId,
		});
		expect(state.outcomes).toHaveLength(0);
	});

	it("cancels a pending Claude turn on terminal but not on close", async () => {
		const terminal = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		terminal.dispatchCall(callOf(1));
		await waitFor(() => terminal.calls.some((op) => op.kind === "claudeRun"));
		terminal.rows.push({
			kind: "settle",
			settleOrdinal: 1,
			issueOrdinal: 1,
			outcome: "interrupted",
			answer: null,
			reason: "cancelled",
		});
		terminal.dispatch.port.settled?.(callOf(1), { outcome: "interrupted", answer: null, reason: "cancelled" });
		terminal.record.status = "cancelled";
		terminal.dispatch.port.terminal?.(terminal.record, "cancelled");
		await waitFor(() => terminal.calls.some((op) => op.kind === "claudeCancel"));
		expect(terminal.calls.find((op) => op.kind === "claudeCancel")).toMatchObject({ runId });

		const closed = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		closed.dispatchCall(callOf(1));
		await waitFor(() => closed.calls.some((op) => op.kind === "claudeRun"));
		closed.dispatch.port.stop?.();
		expect(closed.calls.some((op) => op.kind === "claudeCancel")).toBe(false);
	});

	it("cancels from the journal: a lost accept reply, a failed cancel retried on the tick, a new daemon asked again", async () => {
		const state = setup({
			agentsFile: { kind: "read", text: "Instructions" },
			runReplies: [{ ok: false, error: "the host daemon did not take the request" }],
			cancelReplies: [{ ok: false, error: "timed out", errorKind: "timeout" }],
		});
		const cancels = () => state.calls.filter((op) => op.kind === "claudeCancel");
		state.dispatchCall(callOf(1));
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		const turn = latestTurn(state.rows, 1);
		state.rows.push({
			kind: "settle",
			settleOrdinal: 1,
			issueOrdinal: 1,
			outcome: "interrupted",
			answer: null,
			reason: "cancelled",
		});
		state.record.status = "cancelled";
		state.dispatch.port.terminal?.(state.record, "cancelled");
		await waitFor(() => cancels().length === 1);
		expect(cancels()[0]).toEqual({
			kind: "claudeCancel",
			runId,
			turnId: turn.turnId,
			target,
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		state.dispatch.port.tick?.();
		await waitFor(() => cancels().length === 2);
		await new Promise((resolve) => setTimeout(resolve, 0));
		state.dispatch.port.tick?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cancels()).toHaveLength(2);

		state.dispatch.port.hostRegistering?.();
		state.setInstanceId("daemon-b");
		state.dispatch.port.hostRegistered?.();
		await waitFor(() => cancels().length === 3);
	});

	it("retries cancellation until acknowledged", async () => {
		const state = setup({
			agentsFile: { kind: "read", text: "Instructions" },
			cancelReplies: [{ ok: true, result: { cancelled: false } }],
		});
		const cancels = () => state.calls.filter((op) => op.kind === "claudeCancel");
		state.dispatchCall(callOf(1));
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		state.record.status = "cancelled";
		state.dispatch.port.terminal?.(state.record, "cancelled");
		await waitFor(() => cancels().length === 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		state.dispatch.port.tick?.();
		await waitFor(() => cancels().length === 2);
		await new Promise((resolve) => setTimeout(resolve, 0));
		state.dispatch.port.tick?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cancels()).toHaveLength(2);
	});

	it("acks a result for a terminal run or an unknown turn without touching the journal", async () => {
		const state = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		state.dispatchCall(callOf(1));
		await waitFor(() => state.calls.some((op) => op.kind === "claudeRun"));
		const turn = latestTurn(state.rows, 1);
		state.record.status = "failed";
		const before = state.rows.length;

		await expect(state.dispatch.claudeTurnResult(resultFor(turn))).resolves.toBeUndefined();
		await expect(
			state.dispatch.claudeTurnResult({ ...resultFor(turn), turnId: "turn-unknown" }),
		).resolves.toBeUndefined();
		expect(state.rows).toHaveLength(before);
	});

	it("interrupts a pending runner only when the register instance changes", async () => {
		const changed = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		changed.dispatchCall(callOf(1));
		await waitFor(() => changed.calls.some((op) => op.kind === "claudeRun"));
		changed.dispatch.port.hostRegistering?.();
		changed.setInstanceId("daemon-b");
		changed.dispatch.port.hostRegistered?.();
		await waitFor(() => changed.outcomes.length === 1);
		expect(changed.outcomes[0]).toMatchObject({
			outcome: "interrupted",
			reason: "runner lost: the host daemon restarted",
		});
		await waitFor(() => changed.calls.some((op) => op.kind === "claudeCancel"));
		expect(changed.record.status).toBe("running");

		const same = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		same.dispatchCall(callOf(1));
		await waitFor(() => same.calls.some((op) => op.kind === "claudeRun"));
		same.dispatch.port.hostRegistering?.();
		same.dispatch.port.hostRegistered?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(same.outcomes).toHaveLength(0);
		expect(same.calls.filter((op) => op.kind === "claudeRun")).toHaveLength(1);
		expect(same.calls.some((op) => op.kind === "claudeCancel")).toBe(false);
	});

	it("marks Claude refusals unavailable", async () => {
		const refused = setup({
			agentsFile: { kind: "read", text: "Instructions" },
			runReplies: [{ ok: false, error: "claudeRun unavailable" }],
		});
		refused.dispatchCall(callOf(1));
		await waitFor(() => refused.outcomes.length === 1);
		expect(refused.outcomes[0]?.outcome).toBe("unavailable");

		const missing = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		missing.dispatchCall(callOf(1));
		await waitFor(() => missing.calls.some((op) => op.kind === "claudeRun"));
		await missing.dispatch.claudeTurnResult(
			resultFor(latestTurn(missing.rows, 1), "failed", null, "binaryMissing"),
		);
		expect(missing.outcomes[0]?.outcome).toBe("unavailable");

		const rejected = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		rejected.dispatchCall(callOf(1));
		await waitFor(() => rejected.calls.some((op) => op.kind === "claudeRun"));
		await rejected.dispatch.claudeTurnResult(
			resultFor(latestTurn(rejected.rows, 1), "failed", null, "unknown model claude-x"),
		);
		expect(rejected.outcomes[0]?.outcome).toBe("rejected");

		const declined = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		declined.dispatchCall(callOf(1));
		await waitFor(() => declined.calls.some((op) => op.kind === "claudeRun"));
		await declined.dispatch.claudeTurnResult(
			resultFor(latestTurn(declined.rows, 1), "completed", "I cannot help with that."),
		);
		expect(declined.outcomes[0]?.outcome).toBe("declined");

		const structured = setup({ agentsFile: { kind: "read", text: "Instructions" } });
		structured.dispatchCall(callOf(1, { schema: { type: "string" } }));
		await waitFor(() => structured.calls.some((op) => op.kind === "claudeRun"));
		await structured.dispatch.claudeTurnResult(
			resultFor(latestTurn(structured.rows, 1), "completed", "I cannot help is a refusal phrase."),
		);
		expect(structured.outcomes[0]?.outcome).toBe("completed");
	});
});
