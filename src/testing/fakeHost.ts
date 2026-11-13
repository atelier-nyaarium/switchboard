// The host daemon as the gateway sees it.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayGraph } from "../gateway/composeGateway.js";
import { type AgentDaemonRuntime, createAgentDaemonRuntime } from "../mcp/devcontainer/agentDaemonRuntime.js";
import { createPurge, hostPurgeFiles } from "../mcp/devcontainer/sessionPurge.js";
import { AGENT_BACKENDS, type AgentBackendId, agentFrameType } from "../shared/agent-backend.js";
import { type AgentDaemonCommand, agentWire } from "../shared/agent-wire.js";
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
	type HostPurgeOp,
	type PurgeOutcome,
} from "../shared/host-op.js";
import { HOST_SPAWN, isHostSpawn } from "../shared/host-spawn.js";
import type { LaunchFailure } from "../shared/launch-notice.js";
import type { SessionHarness } from "../shared/session-harness.js";
import { createFakeSocket, type Frame } from "./fakeSocket.js";
import { type ScriptedAgents, scriptedAgents } from "./scriptedAgents.js";

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
	onClaudeRun?: ClaudeResponder;
	onClaudeAck?: (frame: ClaudeTurnAckFrame) => void;
	/** A skill file's text; absent reads as missing. */
	skillText?: (path: string) => string | undefined;
	/** Dropped frames remain buffered. */
	loseAgentFrames?: boolean;
	/** Link drops acknowledgements. */
	loseAgentAcks?: boolean;
	/** Commands log before delivery. */
	loseAgentCommands?: boolean;
	/** Unscripted thread purges use daemon deletion. */
	onPurge?: (op: HostPurgeOp) => PurgeOutcome | "fail" | undefined;
	/** Drop pane-kill replies. */
	silentKills?: boolean;
}

export type ClaudeResponder = (op: HostClaudeRunOp) => FakeClaudeResult | undefined;

export interface FakeClaudeResult {
	outcome?: ClaudeTurnResultFrame["outcome"];
	answer?: ClaudeTurnResultFrame["answer"];
	reason?: string | null;
	delayMs?: number;
}

/** Runtime outlives socket. */
export interface HarnessAgentDaemon {
	daemonInstanceId: string;
	runtime: AgentDaemonRuntime;
	/** Null detaches socket. */
	attach(sink: ((frame: Frame) => void) | null): void;
	/** Shutdown kills children. */
	shutdown(): void;
}

export interface FakeHostOptions extends FakeHostHandlers {
	token: string;
	/** Projects the catalog frame announces. */
	projects?: Array<{ team: string; projectPath: string }>;
	hostSpawns?: string[];
	/** Absent sends Claude everywhere, under both names. */
	spawnLists?: FakeSpawnLists;
	screen?: string;
	entries?: string[];
	agentDaemon?: HarnessAgentDaemon;
	deferCatalog?: boolean;
	/** False simulates an older daemon. Default true. */
	launchIds?: boolean;
	/** Purge home; generated home removed on close. */
	home?: string;
}

export interface FakeHost {
	frames: Frame[];
	home: string;
	daemonInstanceId: string;
	/** Forwarded runtime frames, ordered. */
	daemonFrames: Frame[];
	/** Every relayed HostOp, in order. */
	ops: HostOp[];
	/** Every wake frame. */
	wakes: Frame[];
	/** Request-order purge log. */
	purges: HostPurgeOp[];
	/** Every create's wake. */
	creates: FakeCreate[];
	/** Gateway commands, schema-checked. */
	agentCommands(backend: AgentBackendId): AgentDaemonCommand[];
	claudeRuns: HostClaudeRunOp[];
	claudeCancels: HostClaudeCancelOp[];
	claudeResults: ClaudeTurnResultFrame[];
	claudeAcks: ClaudeTurnAckFrame[];
	handlers: FakeHostHandlers;
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

/** The daemon's real agent runtime over scripted backends. It outlives a socket. */
export function createHarnessAgentDaemon(
	agents: ScriptedAgents,
	daemonInstanceId = `harness-daemon-${randomBytes(4).toString("hex")}`,
): HarnessAgentDaemon {
	let sink: ((frame: Frame) => void) | null = null;
	const runtime = createAgentDaemonRuntime({
		daemonInstanceId,
		send: (frame) => sink?.(frame),
		resolveHostCwd: () => HOST_HOME,
		drivers: agents.drivers,
		log: () => () => {},
		clock: agents.clock,
	});
	return {
		daemonInstanceId,
		runtime,
		attach: (next) => {
			sink = next;
		},
		shutdown: () => {
			sink = null;
			runtime.shutdown();
		},
	};
}

export function attachFakeHost(graph: GatewayGraph, options: FakeHostOptions): FakeHost {
	const namesLaunches = options.launchIds ?? true;
	const socket = createFakeSocket();
	socket.onPing(() => graph.wsHandlers.pong(socket.ws));
	const ops: HostOp[] = [];
	const wakes: Frame[] = [];
	const purges: HostPurgeOp[] = [];
	const creates: FakeCreate[] = [];
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
		onClaudeRun: options.onClaudeRun,
		onClaudeAck: options.onClaudeAck,
		skillText: options.skillText,
		loseAgentFrames: options.loseAgentFrames,
		loseAgentAcks: options.loseAgentAcks,
		loseAgentCommands: options.loseAgentCommands,
		onPurge: options.onPurge,
	};
	const ownDaemon = options.agentDaemon ? undefined : createHarnessAgentDaemon(scriptedAgents());
	const agentDaemon = options.agentDaemon ?? ownDaemon!;
	const wires = AGENT_BACKENDS.map(({ id }) => ({
		id,
		command: agentFrameType(id, "command"),
		ack: agentFrameType(id, "ack"),
		parse: agentWire(id).command,
		commands: [] as AgentDaemonCommand[],
	}));
	const send = (frame: Frame): void => graph.wsHandlers.message(socket.ws, JSON.stringify(frame));
	// Host-home deletion; fake containers appear up and empty.
	const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "fake-host-"));
	// A real home is always there.
	fs.mkdirSync(home, { recursive: true });
	const purge = createPurge({
		// Each spawn point has its own home.
		homeOf: (spawn) => {
			const at = spawn === undefined || spawn === HOST_SPAWN ? home : path.join(home, spawn);
			fs.mkdirSync(at, { recursive: true });
			return { home: at, claudeDir: path.join(at, ".claude") };
		},
		files: hostPurgeFiles(),
		exec: async () => "",
		closePane: async (_pane, then) => then?.(),
		deleteThread: (backend, target, threadId) => agentDaemon.runtime.deleteThread(backend, target, threadId),
	});
	const claudeTurnKey = (runId: string, turnId: string): string => JSON.stringify([runId, turnId]);
	const sendClaudeResult = (frame: ClaudeTurnResultFrame): void => {
		const checked = ClaudeTurnResultFrameSchema.parse(frame);
		claudeResults.push(checked);
		if (socket.ws.readyState === 1) send(checked);
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
			case "purge":
				return { outcome: "deleted" };
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
			if (op.kind === "agentModels") {
				void agentDaemon.runtime
					.listModels(op.backend, op.target)
					.then((result) => send({ type: "host_op_reply", reqId: frame.reqId, ok: true, result }));
				return;
			}
			if (op.kind === "purge") {
				purges.push(op);
				const scripted = handlers.onPurge?.(op);
				const outcome: Promise<PurgeOutcome> =
					scripted === "fail"
						? Promise.reject(new Error("purge failed"))
						: scripted !== undefined
							? Promise.resolve(scripted)
							: purge(op);
				void outcome.then(
					(done) => send({ type: "host_op_reply", reqId: frame.reqId, ok: true, result: { outcome: done } }),
					(error: unknown) =>
						send({
							type: "host_op_reply",
							reqId: frame.reqId,
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}),
				);
				return;
			}
			if (op.kind === "killSession" && handlers.silentKills) return;
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
		for (const wire of wires) {
			if (frame.type === wire.command) {
				wire.commands.push(wire.parse.parse(frame));
				if (handlers.loseAgentCommands) return;
			}
			if (frame.type === wire.ack && handlers.loseAgentAcks) return;
		}
		agentDaemon.runtime.receive(frame);
	});
	graph.wsHandlers.open(socket.ws);
	send({
		type: "register",
		team: "host",
		subId: "fake-host",
		token: options.token,
		daemonInstanceId: agentDaemon.daemonInstanceId,
	});
	const daemonFrames: Frame[] = [];
	agentDaemon.attach((frame) => {
		if (socket.ws.readyState !== 1 || handlers.loseAgentFrames) return;
		daemonFrames.push(frame);
		send(frame);
	});
	agentDaemon.runtime.connected();
	const announceCatalog = (): void => {
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
		home,
		daemonInstanceId: agentDaemon.daemonInstanceId,
		daemonFrames,
		ops,
		wakes,
		purges,
		creates,
		agentCommands: (backend) => wires.find((wire) => wire.id === backend)?.commands ?? [],
		claudeRuns,
		claudeCancels,
		claudeResults,
		claudeAcks,
		handlers,
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
			ownDaemon?.shutdown();
			if (!options.home) fs.rmSync(home, { recursive: true, force: true });
		},
		vanish: () => socket.ws.close(),
	};
}
