// The host daemon as the gateway sees it.

import { randomBytes } from "node:crypto";
import type { GatewayGraph } from "../gateway/composeGateway.js";
import { type AgentBackendId, agentFrameType, GENERIC_AGENT_BACKENDS } from "../shared/agent-backend.js";
import type { AgentExecutionTarget, AgentResolvedTarget } from "../shared/agent-execution-target.js";
import {
	type AgentDaemonCommand,
	type AgentDaemonEvent,
	type AgentDaemonReceipt,
	agentWire,
} from "../shared/agent-wire.js";
import {
	type CodexDaemonCommand,
	CodexDaemonCommandSchema,
	type CodexDaemonEvent,
	CodexDaemonEventSchema,
	type CodexDaemonReceipt,
	CodexDaemonReceiptSchema,
} from "../shared/codexAgentRelay.js";
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
import { HOST_SPAWN, isHostSpawn } from "../shared/host-spawn.js";
import type { LaunchFailure } from "../shared/launch-notice.js";
import type { SessionHarness } from "../shared/session-harness.js";
import { createFakeSocket, type Frame } from "./fakeSocket.js";

/** The catalog frame's per-CLI fields. */
export interface FakeSpawnLists {
	harnessSpawns?: Partial<Record<SessionHarness, string[]>>;
	/** An older daemon's names. */
	claudeSpawns?: string[];
	copilotSpawns?: string[];
}

/** A create's wake frame. */
export interface FakeCreate {
	team: string;
	target: { kind: "host" | "devcontainer"; name: string; sessionName: string };
	launchId?: string;
	harness?: string;
	sessionToken?: string;
	workdirHint?: string;
	resumeSessionId?: string;
	fresh?: true;
}

export interface FakeHostHandlers {
	/** The scenario registers the launched session. */
	onCreateSession?: (create: FakeCreate) => void;
	/** An answer fails that launch. */
	failCreateSession?: (create: FakeCreate) => string | { error: string; failure: LaunchFailure } | undefined;
	/** The scenario registers the woken team. */
	onWake?: (frame: Frame) => void;
	/** How the daemon answers a wake; absent says it launched. */
	answerWake?: (frame: Frame) => "launched" | "failed" | "silent" | { failure: LaunchFailure };
	/** Absent means accept and complete. */
	onCodexCommand?: CodexResponder;
	onAgentCommand?: AgentResponder;
	onClaudeRun?: ClaudeResponder;
	onClaudeAck?: (frame: ClaudeTurnAckFrame) => void;
	/** A skill file's text; absent reads as missing. */
	skillText?: (path: string) => string | undefined;
}

export type CodexResponder = (command: CodexDaemonCommand, daemon: FakeCodexDaemon) => Array<Frame> | undefined;
/** Every backend on the generic stack. */
export type AgentResponder = (
	command: AgentDaemonCommand,
	daemon: FakeAgentDaemon,
	backend: AgentBackendId,
) => Array<Frame> | undefined;
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

export type FakeAgentDaemon = FakeCodexDaemon;

export interface FakeHostOptions extends FakeHostHandlers {
	token: string;
	/** Projects the catalog frame announces. */
	projects?: Array<{ team: string; projectPath: string }>;
	hostSpawns?: string[];
	/** Absent sends Claude everywhere, under both names. */
	spawnLists?: FakeSpawnLists;
	screen?: string;
	entries?: string[];
	/** A reconnecting daemon brings its own. */
	daemon?: FakeCodexDaemon;
	deferCatalog?: boolean;
	/** False simulates an older daemon. Default true. */
	launchIds?: boolean;
}

export interface FakeHost {
	frames: Frame[];
	/** Every relayed HostOp, in order. */
	ops: HostOp[];
	/** Every wake frame. */
	wakes: Frame[];
	/** Every create's wake. */
	creates: FakeCreate[];
	/** Every Codex command, schema-checked. */
	codexCommands: CodexDaemonCommand[];
	/** Every command a generic backend took, schema-checked. */
	agentCommands(backend: AgentBackendId): AgentDaemonCommand[];
	claudeRuns: HostClaudeRunOp[];
	claudeCancels: HostClaudeCancelOp[];
	claudeResults: ClaudeTurnResultFrame[];
	claudeAcks: ClaudeTurnAckFrame[];
	handlers: FakeHostHandlers;
	daemon: FakeCodexDaemon;
	agentDaemon(backend: AgentBackendId): FakeAgentDaemon;
	/** One daemon frame to the gateway. */
	sendCodex(frame: CodexDaemonEvent | CodexDaemonReceipt): void;
	sendAgent(backend: AgentBackendId, frame: AgentDaemonEvent | AgentDaemonReceipt): void;
	announceCatalog(): void;
	/** What the daemon derives from that session's pane; null is nobody having said. */
	reportWorking(team: string, working: boolean | null, compacting?: boolean): void;
	/** Any other daemon frame. */
	sendFrame(frame: Frame): void;
	close(): void;
	/** The link dies before the Gateway hears it close. */
	vanish(): void;
}

const HOST_HOME = "/home/fixture";

function createOf(frame: Frame): FakeCreate {
	const team = String(frame.team);
	const dot = team.indexOf(".");
	const name = team.slice(0, dot);
	const text = (key: string) => (typeof frame[key] === "string" ? { [key]: frame[key] as string } : {});
	return {
		team,
		target: { kind: isHostSpawn(name) ? "host" : "devcontainer", name, sessionName: team.slice(dot + 1) },
		...text("launchId"),
		...text("harness"),
		...text("sessionToken"),
		...text("workdirHint"),
		...text("resumeSessionId"),
		...(frame.fresh === true ? { fresh: true as const } : {}),
	};
}

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

export function attachFakeHost(graph: GatewayGraph, options: FakeHostOptions): FakeHost {
	const namesLaunches = options.launchIds ?? true;
	const socket = createFakeSocket();
	socket.onPing(() => graph.wsHandlers.pong(socket.ws));
	const ops: HostOp[] = [];
	const wakes: Frame[] = [];
	const creates: FakeCreate[] = [];
	const codexCommands: CodexDaemonCommand[] = [];
	const claudeRuns: HostClaudeRunOp[] = [];
	const claudeCancels: HostClaudeCancelOp[] = [];
	const claudeResults: ClaudeTurnResultFrame[] = [];
	const claudeAcks: ClaudeTurnAckFrame[] = [];
	const activeClaudeTurns = new Map<string, ReturnType<typeof setTimeout>>();
	const handlers: FakeHostHandlers = {
		onCreateSession: options.onCreateSession,
		failCreateSession: options.failCreateSession,
		onWake: options.onWake,
		answerWake: options.answerWake,
		onCodexCommand: options.onCodexCommand,
		onAgentCommand: options.onAgentCommand,
		onClaudeRun: options.onClaudeRun,
		onClaudeAck: options.onClaudeAck,
	};
	const daemon = options.daemon ?? createFakeCodexDaemon();
	const agents = new Map(
		GENERIC_AGENT_BACKENDS.map(({ id }) => [
			id,
			{ daemon: createFakeCodexDaemon(daemon.daemonInstanceId), commands: [] as AgentDaemonCommand[] },
		]),
	);
	const agentOf = (backend: AgentBackendId) => {
		const held = agents.get(backend);
		if (!held) throw new Error(`no fake daemon for ${backend}`);
		return held;
	};
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
	const sendAgent = (backend: AgentBackendId, frame: AgentDaemonEvent | AgentDaemonReceipt): void => {
		const wire = agentWire(backend);
		const turns = agentOf(backend).daemon.turns;
		const checked =
			frame.type === agentFrameType(backend, "event") ? wire.event.parse(frame) : wire.receipt.parse(frame);
		if (checked.kind === "accepted") turns.set(checked.turnId, "inProgress");
		if (checked.kind === "terminal") turns.set(checked.turnId, checked.state);
		send(checked);
	};
	const answer = (op: HostOp): unknown => {
		switch (op.kind) {
			case "peek":
				return { kind: "tmux", ansi: options.screen ?? "$ ", hash: "h1" };
			case "listDirs":
				return { entries: options.entries ?? ["projects"], path: op.path || HOST_HOME };
			case "readSkill": {
				const text = handlers.skillText?.(op.path);
				return text === undefined ? { kind: "refused", code: "missing" } : { kind: "read", text };
			}
			case "kasaScan":
				return { candidates: [] };
			case "sendText":
			case "sendKey":
				return { sent: true };
			case "typeIntoPane":
				return { typed: true };
			case "killSession":
				return { killed: true };
			case "reloadPlugins":
				return { initiated: true };
			case "containerStart":
			case "containerStop":
				return { accepted: true };
			case "answerPrompt":
				return { outcome: "answered" };
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
			const named = namesLaunches && frame.launchId ? { launchId: frame.launchId } : {};
			const create = frame.door === "create" ? createOf(frame) : undefined;
			if (create) creates.push(create);
			const refused = create ? handlers.failCreateSession?.(create) : undefined;
			const answer = refused ? "refused" : (handlers.answerWake?.(frame) ?? "launched");
			// Answers cross a socket.
			setTimeout(() => {
				if (typeof refused === "string")
					send({ type: "wake_result", team: frame.team, ...named, success: false, error: refused });
				else if (refused) send({ type: "wake_result", team: frame.team, ...named, success: false, ...refused });
				else if (typeof answer === "object")
					send({ type: "wake_result", team: frame.team, ...named, success: false, ...answer });
				else if (answer !== "silent")
					send({ type: "wake_result", team: frame.team, ...named, success: answer === "launched" });
				// The shell comes up after the answer.
				if (create && answer === "launched") setTimeout(() => handlers.onCreateSession?.(create), 0);
			}, 0);
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
		for (const [backend, held] of agents) {
			if (frame.type !== agentFrameType(backend, "command")) continue;
			const command = agentWire(backend).command.parse(frame);
			held.commands.push(command);
			const targetId =
				command.kind === "start" ? held.daemon.resolve(command.target).targetId : command.target.targetId;
			if (!held.daemon.targets.has(targetId)) held.daemon.targets.set(targetId, held.daemon.generation);
			const responder = handlers.onAgentCommand ?? stockAgentResponder;
			for (const reply of responder(command, held.daemon, backend) ?? [])
				sendAgent(backend, reply as AgentDaemonEvent | AgentDaemonReceipt);
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
		for (const [backend, held] of agents) {
			send({
				type: agentFrameType(backend, "hello"),
				daemonInstanceId: held.daemon.daemonInstanceId,
				targets: [...held.daemon.targets].map(([targetId, generation]) => ({ targetId, generation })),
			});
		}
		const hostSpawns = options.hostSpawns ?? [];
		const harnessSpawns: Record<SessionHarness, string[]> = {
			claude: [HOST_SPAWN, ...hostSpawns],
			opencode: [],
			copilot: [],
		};
		const lists: FakeSpawnLists = options.spawnLists ?? {
			harnessSpawns,
			claudeSpawns: harnessSpawns.claude,
			copilotSpawns: harnessSpawns.copilot,
		};
		send({
			type: "catalog",
			projects: options.projects ?? [],
			hostSpawns,
			...lists,
			...(namesLaunches ? { launchIds: true } : {}),
		});
	};
	if (!options.deferCatalog) announceCatalog();
	return {
		frames: socket.sent,
		ops,
		wakes,
		creates,
		codexCommands,
		agentCommands: (backend) => agentOf(backend).commands,
		claudeRuns,
		claudeCancels,
		claudeResults,
		claudeAcks,
		handlers,
		daemon,
		agentDaemon: (backend) => agentOf(backend).daemon,
		sendCodex,
		sendAgent,
		announceCatalog,
		sendFrame: send,
		reportWorking: (team, working, compacting) =>
			send({
				type: "presence_derive",
				team,
				...(working === null ? {} : { working, needsLogin: false, limitBlocked: false }),
				...(compacting === undefined ? {} : { compacting }),
			}),
		close: () => {
			for (const timer of activeClaudeTurns.values()) clearTimeout(timer);
			activeClaudeTurns.clear();
			socket.ws.close();
			graph.wsHandlers.close(socket.ws);
		},
		vanish: () => socket.ws.close(),
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

export const stockAgentResponder: AgentResponder = (command, daemon, backend) => {
	if (command.kind === "reconcile") {
		const turnState = command.turnId ? daemon.turns.get(command.turnId) : undefined;
		return [
			{
				type: agentFrameType(backend, "receipt"),
				requestId: command.requestId,
				ownerKey: command.ownerKey,
				daemonInstanceId: daemon.daemonInstanceId,
				targetId: command.target.targetId,
				generation: daemon.generation,
				eventId: daemon.nextEventId(command.target.targetId),
				agentId: command.agentId,
				kind: "reconciled",
				resolvedTarget: command.target,
				sessionId: command.sessionId,
				...(command.turnId ? { turnId: command.turnId } : {}),
				...(command.turnId && turnState === "inProgress" ? { turnState: "inProgress" as const } : {}),
			},
		];
	}
	if (command.kind !== "start" && command.kind !== "message") return [];
	const resolvedTarget = command.kind === "start" ? daemon.resolve(command.target) : command.target;
	const sessionId = command.kind === "start" ? `session-${command.agentId}` : command.sessionId;
	const steeredTurnId =
		command.kind === "message" &&
		command.expectedTurnId &&
		daemon.turns.get(command.expectedTurnId) === "inProgress"
			? command.expectedTurnId
			: undefined;
	const turnId = steeredTurnId ?? `turn-${command.operationId}`;
	const base = {
		ownerKey: command.ownerKey,
		daemonInstanceId: daemon.daemonInstanceId,
		targetId: resolvedTarget.targetId,
		generation: daemon.generation,
		agentId: command.agentId,
	};
	return [
		{
			type: agentFrameType(backend, "receipt"),
			requestId: command.requestId,
			...base,
			eventId: daemon.nextEventId(resolvedTarget.targetId),
			kind: "accepted",
			operationId: command.operationId,
			resolvedTarget,
			sessionId,
			turnId,
			delivery: steeredTurnId ? "steered" : "started",
		},
		{
			type: agentFrameType(backend, "event"),
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
