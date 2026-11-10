import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { agentEnvPrefix, agentFrameType, CODEX_BACKEND, COPILOT_BACKEND } from "../../shared/agent-backend.js";
import { isBinaryOnPath } from "../../shared/agent-binary.js";
import { AgentExecutionTargetSchema } from "../../shared/agent-execution-target.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import { daemonCapabilityDeclaration } from "../../shared/capabilities.js";
import { CodexEventAckSchema } from "../../shared/codex-agent.js";
import { CopilotEventAckSchema } from "../../shared/copilot-agent.js";
import {
	ClaudeTurnAckFrameSchema,
	classifyPeekError,
	HostClaudeCancelOpSchema,
	HostClaudeRunOpSchema,
	type HostOp,
	HostReadSkillOpSchema,
	isReservedHostSession,
	isTmuxName,
	paneKey,
	type TmuxTarget,
} from "../../shared/host-op.js";
import { HOST_SPAWN, isHostSpawn, WINDOWS_SPAWN } from "../../shared/host-spawn.js";
import { moduleDir, packageRoot } from "../../shared/plugin-root.js";
import { createReconnector } from "../../shared/reconnect.js";
import { DerivedPresenceSchema } from "../../shared/schemasPresence.js";
import {
	type ApiRoad,
	HARNESS,
	type PaneRoad,
	paneRoad,
	SESSION_HARNESSES,
	type SessionHarness,
} from "../../shared/session-harness.js";
import { parseSessionName } from "../../shared/session-id.js";
import { ASKPASS_BUNDLE, installAskpassWrapper, removeAskpassWrapper } from "../../shared/vault-askpass-wrapper.js";
import { createClaudeRunner } from "./claudeRunner.js";
import { CodexDaemonService } from "./codexDaemonService.js";
import { ExecutionTargetManager, targetLogger } from "./codexTargets.js";
import { type CompactionFollow, createCompactionFollower } from "./copilotCompaction.js";
import { CopilotDaemonService } from "./copilotDaemonService.js";
import { copilotLauncher } from "./copilotTargets.js";
import { ensureContainerUpAsync, resolveProject } from "./helpers.js";
import { createHostOpRunner } from "./hostOpRunner.js";
import {
	ensureAssistantWorkdir,
	findProjectPath,
	listHostDirs,
	OPENCODE_LAUNCH_BUNDLE,
	resolveHostWorkdir,
	resolveWatchTarget,
	scanDevcontainerProjects,
	setProjectDirs,
} from "./hostResolve.js";
import { createKasaScanner } from "./kasaScan.js";
import { PromptOccurrences, seePrompt } from "./permissionPrompt.js";
import { PresenceScheduler, readWatch, type WatchEntry } from "./presenceScheduler.js";
import { answerPrompt, continueAfterLimit, dismissSurvey, type PromptSight, stopAutoDeny } from "./promptAnswer.js";
import { spawnReloadPlugins } from "./reloadPlugins.js";
import {
	createSessionLaunch,
	type LaunchOutcome,
	resolveLaunchHarness,
	type SessionLaunchDeps,
} from "./sessionLaunch.js";
import {
	awaitReady,
	ensureSession,
	hasSession,
	isAgentReady,
	isAgentWorking,
	killSession,
	paneAgentState,
	peekPane,
	peekWithFallback,
	reattachStep,
	sendKey,
	sendText,
	typeIntoPane,
	withPane,
} from "./tmuxCore.js";
import { createWifiNetworkReader } from "./wifiNetwork.js";
import {
	detectedHostSpawns,
	listWindowsDirs,
	probeWindowsSpawn,
	resolveWindowsWorkdir,
	type WindowsSpawnAvailability,
} from "./windowsSpawn.js";
import { readWorkflowSkill } from "./workflowSkillRead.js";

////////////////////////////////
//  Interfaces & Types

export type ChannelPushHandler = (msg: Record<string, unknown>) => void;

////////////////////////////////
//  Functions & Helpers

let ws: WebSocket | null = null;
let gatewayUrl = "ws://localhost:20000";
let channelPushHandler: ChannelPushHandler | null = null;
const reconnector = createReconnector(() => connect());

/** Probed once per process. PowerShell startup is ~0.36s, which is fine at register and not fine on
 * every wake, and a machine does not gain or lose a Windows side while the daemon runs. A restart is
 * the invalidation, which is also what installing the CLI would prompt. */
let windowsSpawn: WindowsSpawnAvailability | null = null;
function windowsAvailability(): WindowsSpawnAvailability {
	if (!windowsSpawn) {
		windowsSpawn = probeWindowsSpawn();
		const detail = windowsSpawn.available ? `home ${windowsSpawn.userProfile}` : windowsSpawn.reason;
		console.error(`[host-daemon] windows spawn point: ${windowsSpawn.available ? "available" : "no"} (${detail})`);
	}
	return windowsSpawn;
}

/** The ONE place a host spawn point's working directory is resolved, so the wake path and the
 * console's create_session cannot answer differently for the same hint. Returns an error rather than
 * a fallback for a spawn point that cannot use the host's own paths: silently substituting a
 * directory is how a session ends up working somewhere nobody asked for. */
function resolveSpawnWorkdir(spawn: string, hint: string | undefined): { workdir: string } | { error: string } {
	if (spawn !== WINDOWS_SPAWN) return { workdir: resolveHostWorkdir(hint) };
	const probe = windowsAvailability();
	if (!probe.available || !probe.userProfile) {
		return { error: `this machine cannot run a windows session (${probe.reason ?? "unavailable"})` };
	}
	return resolveWindowsWorkdir(hint, probe.userProfile);
}
// Per process, not per socket.
const daemonInstanceId = crypto.randomUUID();
const codexTargets = new ExecutionTargetManager();
const codexDaemon = new CodexDaemonService({
	targets: codexTargets,
	daemonInstanceId,
	send: safeSend,
	resolveHostCwd: (hint) => resolveHostWorkdir(hint),
});
const copilotTargets = new ExecutionTargetManager(
	copilotLauncher,
	undefined,
	targetLogger("copilot-target"),
	undefined,
	agentEnvPrefix("copilot"),
);
const copilotDaemon = new CopilotDaemonService({
	targets: copilotTargets,
	daemonInstanceId,
	send: safeSend,
	resolveHostCwd: (hint) => resolveHostWorkdir(hint),
});
const AGENT_DAEMON_BINDINGS = [
	{ descriptor: CODEX_BACKEND, targets: codexTargets, service: codexDaemon, parseAck: CodexEventAckSchema },
	{ descriptor: COPILOT_BACKEND, targets: copilotTargets, service: copilotDaemon, parseAck: CopilotEventAckSchema },
] as const;
// A second wake kills a starting session.
const inflightWakes = new Map<string, Promise<void>>();

// A send mid-close throws.
function safeSend(payload: Record<string, unknown>): void {
	try {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
	} catch (err) {
		console.error("[host-daemon] ws send failed:", err instanceof Error ? err.message : err);
	}
}

/** Stop supervised agent processes. */
export function stopSupervisedChildren(): void {
	claudeRunner.stop();
	for (const { service, targets } of AGENT_DAEMON_BINDINGS) {
		service.shutdown();
		targets.shutdown();
	}
}

/** Stops the reconnect timer as well as the children, so shutdown leaves nothing scheduled. */
export function stopHostDaemon(): void {
	reconnector.cancel();
	compactionFollower.stop();
	stopSupervisedChildren();
	if (askpassReceipt) removeAskpassWrapper(os.homedir(), askpassReceipt);
}

/** What this process wrote, or nothing. */
let askpassReceipt: string | null = null;

function layDownAskpass(): void {
	const bundle = path.join(packageRoot(moduleDir(import.meta.url)), "dist", ASKPASS_BUNDLE);
	if (!fs.existsSync(bundle)) {
		console.error(`[host-daemon] no askpass bundle at ${bundle}; sessions get no helper`);
		return;
	}
	try {
		const { bin, text } = installAskpassWrapper(os.homedir(), {
			bun: process.execPath,
			bundle,
			gatewayUrl: process.env.BRIDGE_ROUTER_URL,
		});
		askpassReceipt = text;
		console.error(`[host-daemon] askpass helper at ${bin}`);
	} catch (err) {
		console.error(`[host-daemon] askpass helper not written: ${err instanceof Error ? err.message : err}`);
	}
}

export function startHostDaemon(dirs?: string[], onChannelPush?: ChannelPushHandler): void {
	if (dirs && dirs.length > 0) {
		setProjectDirs(dirs);
	}
	if (onChannelPush) {
		channelPushHandler = onChannelPush;
	}
	const envUrl = process.env.BRIDGE_ROUTER_URL;
	if (envUrl) {
		gatewayUrl = envUrl.replace(/^http/, "ws");
	}
	layDownAskpass();
	connect();
}

function connect(): void {
	ws = new WebSocket(`${gatewayUrl}/bridge`);

	ws.on("open", () => {
		console.error("[host-wake] connected to gateway");
		reconnector.reset();
		// The host slot is fail-closed.
		const hostToken = process.env.HOST_WS_TOKEN;
		ws!.send(
			JSON.stringify({
				type: "register",
				team: "host",
				...(hostToken ? { token: hostToken } : {}),
				daemonCapabilities: daemonCapabilityDeclaration(process.env),
				daemonInstanceId,
			}),
		);

		// Replay what the gateway never committed.
		for (const { service } of AGENT_DAEMON_BINDINGS) {
			safeSend(service.hello());
			service.replay();
		}
		claudeRunner.replay();

		const projects = scanDevcontainerProjects();
		// `hostSpawns` names the DETECTED spawn points only; `host` is on every machine and is not
		// announced. An older gateway ignores the field, which is the whole point of announcing before
		// anything consumes it: daemon first, gateway next, console last, each safe on its own.
		const windows = windowsAvailability();
		const hostSpawns = detectedHostSpawns(windows);
		// The phone's create pick and install macros read it.
		const harnessSpawns = Object.fromEntries(
			SESSION_HARNESSES.map((harness) => [
				harness,
				[
					...(hostRuns(harness) ? [HOST_SPAWN] : []),
					...(windows.available && windows.harnesses?.includes(harness) ? [WINDOWS_SPAWN] : []),
				],
			]),
		) as Record<SessionHarness, string[]>;
		ws!.send(
			JSON.stringify({
				type: "catalog",
				projects,
				hostSpawns,
				harnessSpawns,
				// FIXME 2026-11-23: drop both, once every Gateway reads `harnessSpawns`.
				claudeSpawns: harnessSpawns.claude,
				copilotSpawns: harnessSpawns.copilot,
			}),
		);
		console.error(
			`[host-wake] sent catalog with ${projects.length} projects` +
				(hostSpawns.length ? ` and host spawn points: ${hostSpawns.join(", ")}` : ""),
		);

		// observe() fires on transitions, so a stale confirmation re-confirms forever.
		presenceScheduler.clearAll();
	});

	ws.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.type === "wake") {
			const wakeMsg = msg as unknown as WakeMessage;
			if (!inflightWakes.has(wakeMsg.team)) {
				const run = handleWake(wakeMsg)
					.catch((e) => console.error("[host-wake] dispatch error:", e))
					.finally(() => inflightWakes.delete(wakeMsg.team));
				inflightWakes.set(wakeMsg.team, run);
			}
		}

		if (msg.type === "host_op" && typeof msg.reqId === "string") {
			void handleHostOp(msg.reqId as string, msg.op as HostOp).catch((e) =>
				console.error("[host-op] dispatch error:", e),
			);
		}

		for (const { descriptor, service, parseAck } of AGENT_DAEMON_BINDINGS) {
			if (msg.type === agentFrameType(descriptor.id, "command")) service.handleCommand(msg);
			if (msg.type === agentFrameType(descriptor.id, "ack")) {
				const ack = parseAck.safeParse(msg);
				if (ack.success) service.acknowledge(ack.data);
			}
		}
		if (msg.type === "claude_turn_ack") {
			const ack = ClaudeTurnAckFrameSchema.safeParse(msg);
			if (ack.success) claudeRunner.acknowledge(ack.data);
		}

		if (msg.type === "presence_watch" && Array.isArray(msg.watch)) {
			const entries: WatchEntry[] = [];
			const follows: CompactionFollow[] = [];
			for (const raw of msg.watch) {
				const watch = readWatch(raw);
				const target = watch && resolveWatchTarget(watch.team);
				if (!watch || !target) continue;
				// Only a pane is peeked.
				const road = paneRoad(watch.harness);
				if (!road) continue;
				entries.push({ team: watch.team, target, cadenceMs: watch.cadenceMs, harness: watch.harness });
				if (FOLLOWS_EVENTS_FILE[road.compaction] && watch.sessionId) {
					follows.push({ team: watch.team, copilotSessionId: watch.sessionId });
				}
			}
			void presenceScheduler.setWatches(entries);
			compactionFollower.setFollows(follows);
		}

		if (msg.type === "channel_push") {
			if (channelPushHandler) {
				channelPushHandler(msg);
			}
		}
	});

	ws.on("close", () => {
		console.error("[host-wake] disconnected");
		reconnector.schedule();
	});

	ws.on("error", (err: Error) => {
		console.error(`[host-wake] ws error: ${err.message}`);
	});
}

////////////////////////////////
//  Wake handler

interface WakeMessage {
	type: "wake";
	team: string;
	projectPath?: string;
	/** A CLI word, unchecked. */
	harness?: unknown;
	resumeSessionId?: string;
	/** Its session has never confirmed. */
	fresh?: true;
	// Host only: ~/projects/<hint>.
	workdirHint?: string;
	// Proves which record.
	sessionToken?: string;
}

// Independent of the tmux server's PATH.
const LAUNCH_PATH_PREFIX = path.dirname(process.execPath);

/** Each API server's launcher bundle. */
const LAUNCHER_BUNDLES: Record<ApiRoad["server"], string> = { opencode: OPENCODE_LAUNCH_BUNDLE };

const LAUNCH_ROOT = packageRoot(moduleDir(import.meta.url));

/** Where launchers report, or null when it cannot be made. */
function findSessionLauncher(): SessionLaunchDeps["launcher"] {
	const statusDir = path.join(os.homedir(), ".cache", "switchboard", "launch");
	try {
		fs.mkdirSync(statusDir, { recursive: true, mode: 0o700 });
	} catch (err) {
		console.error(`[host-daemon] no launcher status folder: ${err instanceof Error ? err.message : err}`);
		return null;
	}
	return { runtime: process.execPath, root: LAUNCH_ROOT, statusDir };
}

const sessionLauncher = findSessionLauncher();

/** Whether this machine can launch an API server's CLI. */
function launcherFor(server: ApiRoad["server"]): boolean {
	if (!sessionLauncher) return false;
	const bundle = path.join(LAUNCH_ROOT, "dist", LAUNCHER_BUNDLES[server]);
	if (fs.existsSync(bundle)) return true;
	console.error(`[host-daemon] no launcher bundle at ${bundle}`);
	return false;
}

const launchSession = createSessionLaunch({
	hasSession,
	ensureSession,
	killSession,
	awaitReady,
	paneAgentState,
	reattachStep,
	peekScreen: async (target) => (await peekPane(target)).ansi,
	sendText,
	pathPrefix: LAUNCH_PATH_PREFIX,
	launcher: sessionLauncher,
	readFile: (file) => {
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			return undefined;
		}
	},
	removeFile: (file) => fs.rmSync(file, { force: true }),
	isAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (err) {
			// Not ours to signal, yet running.
			return (err as NodeJS.ErrnoException).code === "EPERM";
		}
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
	log: (line) => console.error(`[host-wake] ${line}`),
});

/** A wake result's reason. */
function launchError(res: LaunchOutcome): { error?: string } {
	if (res.limit) return { error: `session limit hit${res.limit.detail ? ` (${res.limit.detail})` : ""}` };
	return res.error ? { error: res.error } : {};
}

/** Whether this machine's host shell can run the CLI. */
function hostRuns(harness: SessionHarness): boolean {
	const row = HARNESS[harness];
	// A launcher-run CLI needs its launcher too.
	if (row.road.kind === "api" && !launcherFor(row.road.server)) return false;
	if (isBinaryOnPath(row.binary.posix)) return true;
	if (!row.binary.homeDir) return false;
	try {
		fs.accessSync(path.join(os.homedir(), row.binary.homeDir, row.binary.posix), fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function handleWake(msg: WakeMessage): Promise<void> {
	// Both segments reach tmux and shell commands.
	const { project, session } = parseSessionName(msg.team);
	if (!isTmuxName(project) || !isTmuxName(session)) {
		console.error(`[host-wake] refusing wake of "${msg.team}": invalid project/session name`);
		safeSend({ type: "wake_result", team: msg.team, success: false, error: "invalid session name" });
		return;
	}
	// Before any container starts.
	const launch = resolveLaunchHarness(msg.harness, {
		kind: isHostSpawn(project) ? "host" : "devcontainer",
		name: project,
		sessionName: session,
	});
	if ("refused" in launch) {
		console.error(`[host-wake] refusing wake of "${msg.team}": ${launch.refused}`);
		safeSend({ type: "wake_result", team: msg.team, success: false, error: launch.refused });
		return;
	}
	const { harness } = launch;
	// The daemon shares this tmux server. Registry-wide rather than the bare literal, so every host
	// spawn point reaches this branch and none falls through to the devcontainer path below, which
	// would look for a container named after a shell.
	if (isHostSpawn(project)) {
		if (isReservedHostSession(session)) {
			console.error(`[host-wake] refusing wake of "${msg.team}": "${session}" is a reserved host session`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: "reserved host session" });
			return;
		}
		// Defence in depth behind the gateway's own rule: a host launch the gateway cannot name a
		// record for carries no token, and nothing on this machine should start a shell for it.
		if (!msg.sessionToken) {
			console.error(`[host-wake] refusing wake of "${msg.team}": no session token`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: "no session token" });
			return;
		}
		const target: TmuxTarget = { kind: "host", name: project, sessionName: session };
		if (msg.team === ASSISTANT_TEAM) {
			try {
				ensureAssistantWorkdir(msg.workdirHint);
			} catch (err) {
				const message = `could not create the assistant's folder: ${err instanceof Error ? err.message : String(err)}`;
				console.error(`[host-wake] refusing wake of "${msg.team}": ${message}`);
				safeSend({ type: "wake_result", team: msg.team, success: false, error: message });
				return;
			}
		}
		// A spawn point whose shell does not share this filesystem needs its own resolution, and one
		// that REFUSES rather than falling back: a Windows session handed a Linux path lands on a UNC
		// cwd, which works well enough to look fine and then strands every subprocess it starts.
		const resolved = resolveSpawnWorkdir(project, msg.workdirHint);
		if ("error" in resolved) {
			console.error(`[host-wake] refusing wake of "${msg.team}": ${resolved.error}`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: resolved.error });
			return;
		}
		console.error(`[host-wake] starting host session ${msg.team}`);
		try {
			const res = await launchSession(target, {
				harness,
				resumeSessionId: msg.resumeSessionId,
				fresh: msg.fresh,
				sessionToken: msg.sessionToken,
				workdir: resolved.workdir,
				existing: "repair",
			});
			if (res.limit) {
				console.error(
					`[host-wake] ${msg.team} hit a usage limit: ${res.limit.headline ?? "no headline on screen"}`,
				);
			} else {
				console.error(`[host-wake] ${msg.team} ${res.live ? "is up" : "did not come up"}`);
			}
			safeSend({
				type: "wake_result",
				team: msg.team,
				success: res.live,
				screen: res.screen,
				...launchError(res),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[host-wake] failed to wake ${msg.team}: ${message}`);
			safeSend({ type: "wake_result", team: msg.team, success: false, error: message });
		}
		return;
	}

	const projectPath = msg.projectPath || findProjectPath(project);

	try {
		const resolved = resolveProject(projectPath);
		const projectName = path.basename(resolved);
		console.error(`[host-wake] starting ${msg.team} at ${resolved}`);

		const { pluginsProvisioned } = await ensureContainerUpAsync(resolved);

		console.error(`[host-wake] ${msg.team} container is up, starting ${HARNESS[harness].label}`);

		const target: TmuxTarget = { kind: "devcontainer", name: projectName, sessionName: session };
		const res = await launchSession(target, {
			harness,
			resumeSessionId: msg.resumeSessionId,
			fresh: msg.fresh,
			sessionToken: msg.sessionToken,
			existing: "peek",
		});
		console.error(`[host-wake] ${msg.team} session ${res.created ? "started" : "already running"}`);
		if (res.limit) {
			console.error(
				`[host-wake] ${msg.team} hit a usage limit: ${res.limit.headline ?? "no headline on screen"}`,
			);
		} else if (res.created) {
			console.error(`[host-wake] ${msg.team} ${res.ready ? "is ready" : "did not come up"}`);
		}

		// Zero captures means a dead launch.
		safeSend({
			type: "wake_result",
			team: msg.team,
			success: res.alive,
			pluginsProvisioned,
			screen: res.screen,
			...launchError(res),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[host-wake] failed to wake ${msg.team}: ${message}`);
		safeSend({ type: "wake_result", team: msg.team, success: false, error: message });
	}
}

////////////////////////////////
//  Host op handler (console terminal view)

// One count per pane, read by presence and the answer alike.
const promptOccurrences = new PromptOccurrences();
// One press per dialog sighting, while its frame repeats.
const LIMIT_ANSWER_GAP_MS = 15_000;
const limitAnsweredAt = new Map<string, number>();
const surveyDismissedAt = new Map<string, number>();
const sightOf =
	(target: TmuxTarget): PromptSight =>
	(screen) =>
		seePrompt(promptOccurrences, paneKey(target), screen);

const claudeRunner = createClaudeRunner({ send: (frame) => safeSend({ ...frame }) });

// The runner owns single-flight and the cadence floor.
const hostOpRunner = createHostOpRunner({
	kasaScan: createKasaScanner(),
	wifiNetwork: createWifiNetworkReader(),
	typeIntoPane,
	// Internal callers use peekPane for its reject-on-absent.
	peekPane: peekWithFallback,
	sendText,
	sendKey,
	answerPrompt: (target, promptId, decision, reason) =>
		withPane(target, (hands) => answerPrompt(hands, sightOf(target), promptId, decision, reason)),
	createSession: async (target, workdirHint, resumeSessionId, sessionToken, harness, fresh) => {
		const launch = resolveLaunchHarness(harness, target);
		// The runner fails the op.
		if ("refused" in launch) throw new Error(launch.refused);
		let workdir: string | undefined;
		if (target.kind === "host") {
			const resolved = resolveSpawnWorkdir(target.name, workdirHint);
			// Thrown rather than swallowed: the runner turns it into a failed op, and the console shows
			// the reason. A silent fallback here would start the session in the wrong tree.
			if ("error" in resolved) throw new Error(resolved.error);
			workdir = resolved.workdir;
		}
		const res = await launchSession(target, {
			harness: launch.harness,
			resumeSessionId,
			fresh,
			sessionToken,
			workdir,
			existing: "leave",
		});
		if (!res.created) return { created: false };
		// The console shows the reason.
		if (res.error) throw new Error(res.error);
		return { created: true, ready: res.ready, alive: res.alive };
	},
	reloadPlugins: async (target) => {
		const pane = await peekPane(target);
		if (!isAgentReady(pane.ansi) || isAgentWorking(pane.ansi)) throw new Error("session is busy");
		spawnReloadPlugins(target);
		return { initiated: true };
	},
	killSession,
	// A windows session browses WINDOWS, through PowerShell. Browsing /mnt from this side would offer
	// Linux directories the launch then refuses, and would miss every network drive.
	listDirs: async (p, spawn) =>
		spawn === WINDOWS_SPAWN ? listWindowsDirs(p, windowsAvailability().userProfile) : listHostDirs(p),
	readSkill: async (target, skillPath) => readWorkflowSkill(target, skillPath),
	claudeRun: (op) => claudeRunner.start(op),
	claudeCancel: (op) => claudeRunner.cancel(op),
});

////////////////////////////////
//  Presence derivation (board tile working/needsLogin/limitBlocked)

// resize=false and priority="derive": never disturb an actively-viewed terminal.
const presenceScheduler = new PresenceScheduler({
	peek: (target) => hostOpRunner.peek(target, { resize: false, priority: "derive" }),
	occurrences: promptOccurrences,
	report: (team, value) => {
		// Parse drops autoDeny. A refused state reads unknown.
		const frame = value ? DerivedPresenceSchema.safeParse(value) : undefined;
		if (frame?.success) safeSend({ type: "presence_derive", team, ...frame.data });
		else {
			if (frame) console.error(`[presence] derived state refused for ${team}`);
			safeSend({ type: "presence_derive", team });
		}
	},
	onRestartPending: (team, pending) => safeSend({ type: "restart_pending", team, pending }),
	onLimitDialog: (target) => {
		const key = paneKey(target);
		const now = Date.now();
		if (now - (limitAnsweredAt.get(key) ?? 0) < LIMIT_ANSWER_GAP_MS) return;
		limitAnsweredAt.set(key, now);
		void withPane(target, (hands) => continueAfterLimit(hands)).catch((e) =>
			console.error("[presence] limit answer failed:", e),
		);
	},
	onSurvey: (target) => {
		const key = paneKey(target);
		const now = Date.now();
		if (now - (surveyDismissedAt.get(key) ?? 0) < LIMIT_ANSWER_GAP_MS) return;
		surveyDismissedAt.set(key, now);
		void withPane(target, (hands) => dismissSurvey(hands)).catch((e) =>
			console.error("[presence] survey dismiss failed:", e),
		);
	},
	onAutoDeny: (target, promptId) => {
		void withPane(target, (hands) => stopAutoDeny(hands, sightOf(target), promptId)).catch((e) =>
			console.error("[presence] auto-deny stop failed:", e),
		);
	},
});

// Copilot's own file says when it compacts; the pane cannot.
/** Whether the daemon tails the CLI's own events file. */
const FOLLOWS_EVENTS_FILE: Record<PaneRoad["compaction"], boolean> = { screen: false, "copilot-events": true };

const compactionFollower = createCompactionFollower({
	home: os.homedir(),
	onChange: (team, compacting) => presenceScheduler.setOverlay(team, compacting ? { compacting: true } : undefined),
});

async function handleHostOp(reqId: string, op: HostOp): Promise<void> {
	try {
		if (op.kind === "claudeRun") {
			const checked = HostClaudeRunOpSchema.safeParse(op);
			if (!checked.success) {
				const target = AgentExecutionTargetSchema.safeParse((op as unknown as { target?: unknown }).target);
				if (!target.success) {
					safeSend({
						type: "host_op_reply",
						reqId,
						ok: true,
						result: { kind: "refused", code: "badTarget" },
					});
					return;
				}
				safeSend({ type: "host_op_reply", reqId, ok: false, error: "invalid claudeRun operation" });
				return;
			}
			safeSend({ type: "host_op_reply", reqId, ok: true, result: await hostOpRunner.run(checked.data) });
			return;
		}
		if (op.kind === "claudeCancel") {
			const checked = HostClaudeCancelOpSchema.safeParse(op);
			if (!checked.success) {
				safeSend({ type: "host_op_reply", reqId, ok: false, error: "invalid claudeCancel operation" });
				return;
			}
			safeSend({ type: "host_op_reply", reqId, ok: true, result: await hostOpRunner.run(checked.data) });
			return;
		}
		if (op.kind === "readSkill") {
			const checked = HostReadSkillOpSchema.safeParse(op);
			if (!checked.success) {
				safeSend({ type: "host_op_reply", reqId, ok: false, error: "invalid readSkill operation" });
				return;
			}
			op = checked.data;
		}
		const result = await hostOpRunner.run(op);
		safeSend({ type: "host_op_reply", reqId, ok: true, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Classified here: the stderr is freshest.
		const errorKind = op.kind === "peek" ? classifyPeekError(message) : undefined;
		safeSend({ type: "host_op_reply", reqId, ok: false, error: message, errorKind });
	}
}
