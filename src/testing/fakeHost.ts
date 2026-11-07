// The host daemon as the gateway sees it.

import { randomBytes } from "node:crypto";
import type { GatewayGraph } from "../gateway/composeGateway.js";
import type { AgentExecutionTarget, AgentResolvedTarget } from "../shared/agent-execution-target.js";
import {
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
} from "../shared/codexAgentRelay.js";
import {
	type CopilotDaemonCommand,
	CopilotDaemonCommandSchema,
	type CopilotDaemonEvent,
	CopilotDaemonEventSchema,
	type CopilotDaemonReceipt,
	CopilotDaemonReceiptSchema,
} from "../shared/copilotAgentRelay.js";
import {
	type ClaudeTurnAckFrame,
	ClaudeTurnAckFrameSchema,
	type ClaudeTurnResultFrame,
	ClaudeTurnResultFrameSchema,
	type HostClaudeCancelOp,
	HostClaudeCancelOpSchema,
	type HostClaudeRunOp,
	HostClaudeRunOpSchema,
	type HostOp,
} from "../shared/host-op.js";
import { createFakeSocket, type Frame } from "./fakeSocket.js";

export interface FakeHostHandlers {
	/** The scenario registers the launched session. */
	onCreateSession?: (op: Extract<HostOp, { kind: "createSession" }>) => void;
	/** The scenario registers the woken team. */
	onWake?: (frame: Frame) => void;
	/** Absent means accept and complete. */
	onCodexCommand?: CodexResponder;
	onCopilotCommand?: CopilotResponder;
	onClaudeRun?: ClaudeResponder;
	onClaudeAck?: (frame: ClaudeTurnAckFrame) => void;
}

export type CodexResponder = (command: CodexDaemonCommand, daemon: FakeCodexDaemon) => Array<Frame> | undefined;
export type CopilotResponder = (command: CopilotDaemonCommand, daemon: FakeCopilotDaemon) => Array<Frame> | undefined;
export type ClaudeResponder = (op: HostClaudeRunOp) => FakeClaudeResult | undefined;

export interface FakeClaudeResult {
	outcome?: ClaudeTurnResultFrame["outcome"];
	answer?: ClaudeTurnResultFrame["answer"];
	reason?: string | null;
	delayMs?: number;
}

export type FakeTurnState = "inProgress" | "completed" | "failed" | "interrupted";

/** One daemon process; outlives the socket. */
export interface FakeCodexDaemon {
	daemonInstanceId: string;
	generation: number;
	/** Targets the hello announces. */
	targets: Map<string, number>;
	/** What a reconcile answers per turn. */
	turns: Map<string, FakeTurnState>;
	/** Next event id per target. */
	nextEventId(targetId: string): number;
	resolve(target: AgentExecutionTarget): AgentResolvedTarget;
}

export interface FakeCopilotDaemon {
	daemonInstanceId: string;
	generation: number;
	targets: Map<string, number>;
	turns: Map<string, FakeTurnState>;
	nextEventId(targetId: string): number;
	resolve(target: AgentExecutionTarget): AgentResolvedTarget;
}

export interface FakeHostOptions extends FakeHostHandlers {
	token: string;
	/** Projects the catalog frame announces. */
	projects?: Array<{ team: string; projectPath: string }>;
	hostSpawns?: string[];
	screen?: string;
	entries?: string[];
	/** A reconnecting daemon brings its own. */
	daemon?: FakeCodexDaemon;
	deferCatalog?: boolean;
}

export interface FakeHost {
	frames: Frame[];
	/** Every relayed HostOp, in order. */
	ops: HostOp[];
	/** Every wake frame, in order. */
	wakes: Frame[];
	/** Every Codex command, schema-checked. */
	codexCommands: CodexDaemonCommand[];
	copilotCommands: CopilotDaemonCommand[];
	claudeRuns: HostClaudeRunOp[];
	claudeCancels: HostClaudeCancelOp[];
	claudeResults: ClaudeTurnResultFrame[];
	claudeAcks: ClaudeTurnAckFrame[];
	handlers: FakeHostHandlers;
	daemon: FakeCodexDaemon;
	copilotDaemon: FakeCopilotDaemon;
	/** One daemon frame to the gateway. */
	sendCodex(frame: CodexDaemonEvent | CodexDaemonReceipt): void;
	sendCopilot(frame: CopilotDaemonEvent | CopilotDaemonReceipt): void;
	announceCatalog(): void;
	/** What the daemon derives from that session's pane; null is nobody having said. */
	reportWorking(team: string, working: boolean | null): void;
	close(): void;
}

const HOST_HOME = "/home/fixture";

export function createFakeCodexDaemon(daemonInstanceId = `fake-daemon-${randomBytes(4).toString("hex")}`) {
	const eventIds = new Map<string, number>();
	const daemon: FakeCodexDaemon = {
		daemonInstanceId,
		generation: 1,
		targets: new Map(),
		turns: new Map(),
		nextEventId: (targetId) => {
			const next = (eventIds.get(targetId) ?? -1) + 1;
			eventIds.set(targetId, next);
			return next;
		},
		resolve: (target) =>
			target.kind === "host"
				? { kind: "host", targetId: "host", cwd: HOST_HOME }
				: { kind: "devcontainer", targetId: `container:${target.project}`, cwd: target.hostProjectPath },
	};
	return daemon;
}

export function createFakeCopilotDaemon(daemonInstanceId: string) {
	const eventIds = new Map<string, number>();
	const daemon: FakeCopilotDaemon = {
		daemonInstanceId,
		generation: 1,
		targets: new Map(),
		turns: new Map(),
		nextEventId: (targetId) => {
			const next = (eventIds.get(targetId) ?? -1) + 1;
			eventIds.set(targetId, next);
			return next;
		},
		resolve: (target) =>
			target.kind === "host"
				? { kind: "host", targetId: "host", cwd: HOST_HOME }
				: { kind: "devcontainer", targetId: `container:${target.project}`, cwd: target.hostProjectPath },
	};
	return daemon;
}

export function attachFakeHost(graph: GatewayGraph, options: FakeHostOptions): FakeHost {
	const socket = createFakeSocket();
	socket.onPing(() => graph.wsHandlers.pong(socket.ws));
	const ops: HostOp[] = [];
	const wakes: Frame[] = [];
	const codexCommands: CodexDaemonCommand[] = [];
	const copilotCommands: CopilotDaemonCommand[] = [];
	const claudeRuns: HostClaudeRunOp[] = [];
	const claudeCancels: HostClaudeCancelOp[] = [];
	const claudeResults: ClaudeTurnResultFrame[] = [];
	const claudeAcks: ClaudeTurnAckFrame[] = [];
	const activeClaudeTurns = new Map<string, ReturnType<typeof setTimeout>>();
	const handlers: FakeHostHandlers = {
		onCreateSession: options.onCreateSession,
		onWake: options.onWake,
		onCodexCommand: options.onCodexCommand,
		onCopilotCommand: options.onCopilotCommand,
		onClaudeRun: options.onClaudeRun,
		onClaudeAck: options.onClaudeAck,
	};
	const daemon = options.daemon ?? createFakeCodexDaemon();
	const copilotDaemon = createFakeCopilotDaemon(daemon.daemonInstanceId);
	const send = (frame: Frame): void => graph.wsHandlers.message(socket.ws, JSON.stringify(frame));
	const claudeTurnKey = (runId: string, turnId: string): string => JSON.stringify([runId, turnId]);
	const sendClaudeResult = (frame: ClaudeTurnResultFrame): void => {
		const checked = ClaudeTurnResultFrameSchema.parse(frame);
		claudeResults.push(checked);
		if (socket.ws.readyState === 1) send(checked);
	};
	const sendCodex = (frame: CodexDaemonEvent | CodexDaemonReceipt): void => {
		const checked =
			frame.type === "codex_event" ? CodexDaemonEventSchema.parse(frame) : CodexDaemonReceiptSchema.parse(frame);
		if (checked.type === "codex_receipt" && checked.kind === "accepted")
			daemon.turns.set(checked.turnId, "inProgress");
		if (checked.type === "codex_event" && checked.kind === "terminal")
			daemon.turns.set(checked.turnId, checked.state);
		send(checked);
	};
	const sendCopilot = (frame: CopilotDaemonEvent | CopilotDaemonReceipt): void => {
		const checked =
			frame.type === "copilot_event"
				? CopilotDaemonEventSchema.parse(frame)
				: CopilotDaemonReceiptSchema.parse(frame);
		if (checked.type === "copilot_receipt" && checked.kind === "accepted")
			copilotDaemon.turns.set(checked.turnId, "inProgress");
		if (checked.type === "copilot_event" && checked.kind === "terminal")
			copilotDaemon.turns.set(checked.turnId, checked.state);
		send(checked);
	};
	const answer = (op: HostOp): unknown => {
		switch (op.kind) {
			case "peek":
				return { kind: "tmux", ansi: options.screen ?? "$ ", hash: "h1" };
			case "listDirs":
				return { entries: options.entries ?? ["projects"], path: op.path || HOST_HOME };
			case "readSkill":
				return { kind: "refused", code: "missing" };
			case "kasaScan":
				return { candidates: [] };
			case "createSession":
				// The shell comes up after the answer.
				setTimeout(() => handlers.onCreateSession?.(op), 0);
				return { created: true, ready: true, alive: true };
			case "sendText":
			case "sendKey":
				return { sent: true };
			case "typeIntoPane":
				return { typed: true };
			case "killSession":
				return { killed: true };
			case "reloadPlugins":
				return { initiated: true };
		}
	};
	socket.onFrame((frame) => {
		if (frame.type === "host_op") {
			const op = frame.op as HostOp;
			ops.push(op);
			if (op.kind === "claudeRun") {
				const run = HostClaudeRunOpSchema.parse(op);
				claudeRuns.push(run);
				const scripted = handlers.onClaudeRun?.(run) ?? { answer: "fake claude answer" };
				const outcome = scripted.outcome ?? "completed";
				const result = ClaudeTurnResultFrameSchema.parse({
					type: "claude_turn_result",
					runId: run.runId,
					turnId: run.turnId,
					sessionId: run.sessionId,
					outcome,
					answer: scripted.answer ?? null,
					reason: scripted.reason ?? (outcome === "completed" ? null : `fake ${outcome}`),
				});
				send({ type: "host_op_reply", reqId: frame.reqId, ok: true, result: { kind: "accepted" } });
				const turnKey = claudeTurnKey(run.runId, run.turnId);
				const timer = setTimeout(() => {
					activeClaudeTurns.delete(turnKey);
					sendClaudeResult(result);
				}, scripted.delayMs ?? 0);
				activeClaudeTurns.set(turnKey, timer);
				return;
			}
			if (op.kind === "claudeCancel") {
				const cancel = HostClaudeCancelOpSchema.parse(op);
				claudeCancels.push(cancel);
				const turnKey = claudeTurnKey(cancel.runId, cancel.turnId);
				const timer = activeClaudeTurns.get(turnKey);
				if (timer) clearTimeout(timer);
				activeClaudeTurns.delete(turnKey);
				send({
					type: "host_op_reply",
					reqId: frame.reqId,
					ok: true,
					result: { cancelled: true },
				});
				return;
			}
			send({ type: "host_op_reply", reqId: frame.reqId, ok: true, result: answer(op) });
		}
		if (frame.type === "claude_turn_ack") {
			const ack = ClaudeTurnAckFrameSchema.parse(frame);
			claudeAcks.push(ack);
			handlers.onClaudeAck?.(ack);
		}
		if (frame.type === "wake") {
			wakes.push(frame);
			handlers.onWake?.(frame);
			send({ type: "wake_result", team: frame.team, success: true });
		}
		if (frame.type === "codex_command") {
			const command = CodexDaemonCommandSchema.parse(frame);
			codexCommands.push(command);
			const targetId =
				command.kind === "start" ? daemon.resolve(command.target).targetId : command.target.targetId;
			if (!daemon.targets.has(targetId)) daemon.targets.set(targetId, daemon.generation);
			const responder = handlers.onCodexCommand ?? stockCodexResponder;
			for (const reply of responder(command, daemon) ?? [])
				sendCodex(reply as CodexDaemonEvent | CodexDaemonReceipt);
		}
		if (frame.type === "copilot_command") {
			const command = CopilotDaemonCommandSchema.parse(frame);
			copilotCommands.push(command);
			const targetId =
				command.kind === "start" ? copilotDaemon.resolve(command.target).targetId : command.target.targetId;
			if (!copilotDaemon.targets.has(targetId)) copilotDaemon.targets.set(targetId, copilotDaemon.generation);
			const responder = handlers.onCopilotCommand ?? stockCopilotResponder;
			for (const reply of responder(command, copilotDaemon) ?? [])
				sendCopilot(reply as CopilotDaemonEvent | CopilotDaemonReceipt);
		}
	});
	graph.wsHandlers.open(socket.ws);
	send({
		type: "register",
		team: "host",
		subId: "fake-host",
		token: options.token,
		daemonInstanceId: daemon.daemonInstanceId,
	});
	const announceCatalog = (): void => {
		send({
			type: "codex_hello",
			daemonInstanceId: daemon.daemonInstanceId,
			targets: [...daemon.targets].map(([targetId, generation]) => ({ targetId, generation })),
		});
		send({
			type: "copilot_hello",
			daemonInstanceId: copilotDaemon.daemonInstanceId,
			targets: [...copilotDaemon.targets].map(([targetId, generation]) => ({ targetId, generation })),
		});
		send({ type: "catalog", projects: options.projects ?? [], hostSpawns: options.hostSpawns ?? [] });
	};
	if (!options.deferCatalog) announceCatalog();
	return {
		frames: socket.sent,
		ops,
		wakes,
		codexCommands,
		copilotCommands,
		claudeRuns,
		claudeCancels,
		claudeResults,
		claudeAcks,
		handlers,
		daemon,
		copilotDaemon,
		sendCodex,
		sendCopilot,
		announceCatalog,
		reportWorking: (team, working) =>
			send({
				type: "presence_derive",
				team,
				...(working === null ? {} : { working, needsLogin: false, limitBlocked: false }),
			}),
		close: () => {
			for (const timer of activeClaudeTurns.values()) clearTimeout(timer);
			activeClaudeTurns.clear();
			socket.ws.close();
			graph.wsHandlers.close(socket.ws);
		},
	};
}

/** Accepts every command and completes each turn at once. */
export const stockCodexResponder: CodexResponder = (command, daemon) => {
	const base = { ownerKey: command.ownerKey, daemonInstanceId: daemon.daemonInstanceId, agentId: command.agentId };
	if (command.kind === "start" || command.kind === "message") {
		const resolvedTarget = command.kind === "start" ? daemon.resolve(command.target) : command.target;
		const { targetId } = resolvedTarget;
		const threadId = command.kind === "start" ? `thread-${command.agentId}` : command.threadId;
		const turnId = `turn-${command.operationId}`;
		const fence = { targetId, generation: daemon.generation };
		return [
			{
				type: "codex_receipt",
				requestId: command.requestId,
				...base,
				...fence,
				eventId: daemon.nextEventId(targetId),
				kind: "accepted",
				operationId: command.operationId,
				resolvedTarget,
				threadId,
				turnId,
				delivery: "started",
			},
			{
				type: "codex_event",
				...base,
				...fence,
				eventId: daemon.nextEventId(targetId),
				threadId,
				kind: "activity",
				turnId,
				itemId: `item-${turnId}`,
				text: "working",
			},
			{
				type: "codex_event",
				...base,
				...fence,
				eventId: daemon.nextEventId(targetId),
				threadId,
				kind: "terminal",
				turnId,
				state: "completed",
				finalResponse: `done: ${command.prompt}`,
			},
		];
	}
	const { targetId } = command.target;
	const fence = { targetId, generation: daemon.generation };
	if (command.kind === "interrupt") {
		return [
			{
				type: "codex_receipt",
				requestId: command.requestId,
				...base,
				...fence,
				eventId: daemon.nextEventId(targetId),
				kind: "interruptResult",
				operationId: command.operationId,
				threadId: command.threadId,
				turnId: command.turnId,
				ok: true,
			},
		];
	}
	const turnState = command.turnId ? daemon.turns.get(command.turnId) : undefined;
	return [
		{
			type: "codex_receipt",
			requestId: command.requestId,
			...base,
			...fence,
			eventId: daemon.nextEventId(targetId),
			kind: "reconciled",
			resolvedTarget: command.target,
			threadId: command.threadId,
			...(command.turnId && turnState ? { turnId: command.turnId, turnState } : {}),
		},
	];
};

export const stockCopilotResponder: CopilotResponder = (command, daemon) => {
	if (command.kind !== "start" && command.kind !== "message") return [];
	const resolvedTarget = command.kind === "start" ? daemon.resolve(command.target) : command.target;
	const sessionId = command.kind === "start" ? `session-${command.agentId}` : command.sessionId;
	const turnId = `turn-${command.operationId}`;
	const base = {
		ownerKey: command.ownerKey,
		daemonInstanceId: daemon.daemonInstanceId,
		targetId: resolvedTarget.targetId,
		generation: daemon.generation,
		agentId: command.agentId,
	};
	return [
		{
			type: "copilot_receipt",
			requestId: command.requestId,
			...base,
			eventId: daemon.nextEventId(resolvedTarget.targetId),
			kind: "accepted",
			operationId: command.operationId,
			resolvedTarget,
			sessionId,
			turnId,
			delivery: command.kind === "start" ? "started" : "followup",
		},
		{
			type: "copilot_event",
			...base,
			eventId: daemon.nextEventId(resolvedTarget.targetId),
			sessionId,
			turnId,
			kind: "terminal",
			state: "completed",
			finalResponse: `done: ${command.prompt}`,
		},
	];
};
