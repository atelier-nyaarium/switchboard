import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { agentEnvPrefix, agentFrameType, CODEX_BACKEND, COPILOT_BACKEND } from "../../shared/agent-backend.js";
import { AgentExecutionTargetSchema } from "../../shared/agent-execution-target.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import { daemonCapabilityDeclaration } from "../../shared/capabilities.js";
import { cliProbeScript, parseCliProbe } from "../../shared/cli-probe.js";
import { placeCandidates } from "../../shared/cli-resolve.js";
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
import { type LaunchFailure, launchFailureText } from "../../shared/launch-notice.js";
import { moduleDir, packageRoot } from "../../shared/plugin-root.js";
import { createReconnector } from "../../shared/reconnect.js";
import { DerivedPresenceSchema } from "../../shared/schemasPresence.js";
import {
	HARNESS,
	type LaunchPlace,
	type PaneRoad,
	paneRoad,
	SESSION_HARNESSES,
	type SessionHarness,
} from "../../shared/session-harness.js";
import { composeSessionName, parseSessionName } from "../../shared/session-id.js";
import { ASKPASS_BUNDLE, installAskpassWrapper, removeAskpassWrapper } from "../../shared/vault-askpass-wrapper.js";
import { createClaudeRunner } from "./claudeRunner.js";
import { CodexDaemonService } from "./codexDaemonService.js";
import { ExecutionTargetManager, targetLogger } from "./codexTargets.js";
import { ContainerStartFailed, ContainerStopped, DevContainers } from "./containers.js";
import { type CompactionFollow, createCompactionFollower } from "./copilotCompaction.js";
import { CopilotDaemonService } from "./copilotDaemonService.js";
import { copilotLauncher } from "./copilotTargets.js";
import { ensureContainerUpAsync, resolveProject } from "./helpers.js";
import { createHostOpRunner } from "./hostOpRunner.js";
import {
	ensureAssistantWorkdir,
	findProjectPath,
	listHostDirs,
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
	type LaunchSite,
	launchAt,
	placementRefusal,
	resolveLaunchHarness,
} from "./sessionLaunch.js";
import {
	awaitReady,
	ensureSession,
	hasSession,
	isAgentReady,
	isAgentWorking,
	killSession,
	paneAgentState,
	paneHolds,
	peekPane,
	peekWithFallback,
	reattachStep,
	runInPlace,
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

/** Probed once per process; PowerShell startup is slow. */
let windowsSpawn: WindowsSpawnAvailability | null = null;
function windowsAvailability(): WindowsSpawnAvailability {
	if (!windowsSpawn) {
		windowsSpawn = probeWindowsSpawn();
		const detail = windowsSpawn.available ? `home ${windowsSpawn.userProfile}` : windowsSpawn.reason;
		console.error(`[host-daemon] windows spawn point: ${windowsSpawn.available ? "available" : "no"} (${detail})`);
	}
	return windowsSpawn;
}

/** The one workdir resolver for wake and create; errors rather than falling back. */
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

/** Stop supervised agent processes and container builds. */
export function stopSupervisedChildren(): void {
	devContainers.close();
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
	if (hostProbeRetry) clearTimeout(hostProbeRetry);
	hostProbeRetry = null;
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
	devContainers.watch();
	connect();
}

const HOST_PROBE_RETRY_MS = 30_000;

/** Last host answer, kept through a failed probe. */
let hostClis: SessionHarness[] | null = null;
let hostProbeRetry: ReturnType<typeof setTimeout> | null = null;

/** True if the host answered. A failure retries. */
async function probeHost(): Promise<boolean> {
	try {
		hostClis = await installedAt({ kind: "host", name: HOST_SPAWN }, { place: "host", assistant: false });
		return true;
	} catch (err) {
		console.error(
			`[host-daemon] could not ask the host shell what it runs: ${err instanceof Error ? err.message : err}`,
		);
		if (!hostProbeRetry) {
			hostProbeRetry = setTimeout(() => {
				hostProbeRetry = null;
				probeHost()
					.then((answered) => (answered ? sendCatalog({ probed: true }) : undefined))
					.catch((e) => console.error("[host-daemon] catalog resend failed:", e));
			}, HOST_PROBE_RETRY_MS);
		}
		return false;
	}
}

async function sendCatalog(opts: { probed?: boolean } = {}): Promise<void> {
	const projects = scanDevcontainerProjects();
	// `hostSpawns` names detected points only; `host` is implicit.
	const windows = windowsAvailability();
	const hostSpawns = detectedHostSpawns(windows);
	if (!opts.probed) await probeHost();
	const onHost = hostClis ?? [];
	const onWindows = windows.available
		? await installedAt({ kind: "host", name: WINDOWS_SPAWN }, { place: "windows", assistant: false })
		: [];
	await devContainers
		.refresh()
		.catch((err) =>
			console.error(`[host-daemon] could not read containers: ${err instanceof Error ? err.message : err}`),
		);
	// The phone's create pick and install macros read it.
	const harnessSpawns = Object.fromEntries(
		SESSION_HARNESSES.map((harness) => [
			harness,
			[
				...(onHost.includes(harness) ? [HOST_SPAWN] : []),
				...(onWindows.includes(harness) ? [WINDOWS_SPAWN] : []),
			],
		]),
	) as Record<SessionHarness, string[]>;
	safeSend({
		type: "catalog",
		projects,
		hostSpawns,
		harnessSpawns,
		containers: devContainers.list(),
		// FIXME 2026-11-23: drop both, once every Gateway reads `harnessSpawns`.
		claudeSpawns: harnessSpawns.claude,
		copilotSpawns: harnessSpawns.copilot,
	});
	console.error(
		`[host-wake] sent catalog with ${projects.length} projects` +
			(hostSpawns.length ? ` and host spawn points: ${hostSpawns.join(", ")}` : ""),
	);
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

		// Gateway forgets stages on reconnect.
		sendCatalog()
			.catch((err) => console.error("[host-daemon] catalog failed:", err))
			.finally(() => {
				for (const [team, frame] of wakeStages) if (inflightWakes.has(team)) safeSend(frame);
			});

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
				madePanes.delete(wakeMsg.team);
				const run = handleWake(wakeMsg)
					.catch((e) => console.error("[host-wake] dispatch error:", e))
					.finally(() => {
						inflightWakes.delete(wakeMsg.team);
						cancelledWakes.delete(wakeMsg.team);
						wakeStages.delete(wakeMsg.team);
					});
				inflightWakes.set(wakeMsg.team, run);
			}
		}

		if (msg.type === "wake_cancel" && typeof msg.team === "string") {
			if (inflightWakes.has(msg.team)) {
				console.error(`[host-wake] the Gateway gave up on ${msg.team}`);
				cancelledWakes.add(msg.team);
			} else {
				cancelFinishedWake(msg.team);
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

const LAUNCH_ROOT = packageRoot(moduleDir(import.meta.url));

/** This machine's own shell, or null when its status folder cannot be made. */
function hostLaunchSite(): LaunchSite | null {
	const statusDir = path.join(os.homedir(), ".cache", "switchboard", "launch");
	try {
		fs.mkdirSync(statusDir, { recursive: true, mode: 0o700 });
	} catch (err) {
		console.error(`[host-daemon] no launcher status folder: ${err instanceof Error ? err.message : err}`);
		return null;
	}
	const statusFile = (target: TmuxTarget) =>
		path.join(statusDir, `${composeSessionName(target.name, target.sessionName)}.json`);
	return {
		runtime: process.execPath,
		root: LAUNCH_ROOT,
		statusFile,
		readStatus: async (target) => {
			try {
				return fs.readFileSync(statusFile(target), "utf8");
			} catch {
				return undefined;
			}
		},
		clearStatus: async (target) => fs.rmSync(statusFile(target), { force: true }),
	};
}

const LAUNCH_SITES: Record<LaunchPlace, LaunchSite | null> = {
	host: hostLaunchSite(),
	windows: null,
	container: null,
};

/** What a place's own shell runs, in offer order. Throws when it cannot be asked. */
async function installedAt(
	where: Pick<TmuxTarget, "kind" | "name">,
	at: { place: LaunchPlace; assistant: boolean },
): Promise<SessionHarness[]> {
	const candidates = placeCandidates(at);
	if (at.place === "windows") {
		const found = windowsAvailability().harnesses ?? [];
		return candidates.filter((harness) => found.includes(harness));
	}
	const site = LAUNCH_SITES[at.place];
	const script = cliProbeScript(candidates, site && { runtime: site.runtime, root: site.root });
	return parseCliProbe(await runInPlace(where, script), candidates);
}

const devContainers = new DevContainers({
	up: ensureContainerUpAsync,
	look: (project) => installedAt({ kind: "devcontainer", name: project }, { place: "container", assistant: false }),
	catalog: scanDevcontainerProjects,
	onChange: (containers) => safeSend({ type: "containers", containers }),
});

/** A catalog project's path; throws for any other. */
function catalogProjectPath(project: string): string {
	if (!isTmuxName(project) || isHostSpawn(project)) throw new Error(`unknown project "${project}"`);
	return resolveProject(findProjectPath(project));
}

/** Missing project or config is a container failure. */
function launchProjectPath(spawn: string, projectPath: string, team: string): string {
	try {
		return resolveProject(projectPath);
	} catch (err) {
		console.error(`[host-wake] ${team}: ${err instanceof Error ? err.message : err}`);
		throw new WakeFailure({ kind: "container", spawn, projectPath }, team);
	}
}

async function launchHarnessFor(word: unknown, target: TmuxTarget) {
	return resolveLaunchHarness(word, target, await installedAt(target, launchAt(target)));
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
	sites: LAUNCH_SITES,
	paneHolds,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
	log: (line) => console.error(`[host-wake] ${line}`),
});

/** A wake that will not come up, as the Gateway reads it. */
class WakeFailure extends Error {
	constructor(
		readonly failure: LaunchFailure,
		team: string,
		message = launchFailureText(failure, team),
	) {
		super(message);
	}
}

/** A launch the Gateway gave up on. */
const cancelledWakes = new Set<string>();

/** Last stage frame per wake. */
const wakeStages = new Map<string, Record<string, unknown>>();

function sendWakeStage(team: string, stage: string, extra: Record<string, unknown> = {}): void {
	const frame = { type: "wake_stage", team, stage, ...extra };
	wakeStages.set(team, frame);
	safeSend(frame);
}

const GAVE_UP: LaunchFailure = { kind: "error", reason: "the Gateway gave up on this launch" };

// Gateway record outlives `container_up` by 10 minutes.
const LATE_CANCEL_MS = 15 * 60_000;

/** Panes of finished, unconfirmed wakes. */
const madePanes = new Map<string, { target: TmuxTarget; at: number }>();

function rememberPane(team: string, target: TmuxTarget, res: LaunchOutcome, fresh: boolean): void {
	const now = Date.now();
	for (const [held, { at }] of madePanes) if (now - at >= LATE_CANCEL_MS) madePanes.delete(held);
	if (res.created && fresh) madePanes.set(team, { target, at: now });
}

/** Stop fails unregistered launches. */
function failStoppedLaunches(project: string): void {
	const now = Date.now();
	for (const [team, made] of madePanes) {
		if (made.target.kind !== "devcontainer" || made.target.name !== project) continue;
		madePanes.delete(team);
		if (now - made.at < LATE_CANCEL_MS) sendWakeFailure(team, { kind: "stopped" });
	}
}

/** A late cancel kills the pane its wake made. */
function cancelFinishedWake(team: string): void {
	const made = madePanes.get(team);
	madePanes.delete(team);
	if (!made || Date.now() - made.at >= LATE_CANCEL_MS) return;
	console.error(`[host-wake] the Gateway gave up on ${team} after it started; closing its pane`);
	killSession(made.target).catch((err) =>
		console.error(`[host-wake] could not close ${team}: ${err instanceof Error ? err.message : err}`),
	);
}

/** Close panes of abandoned wakes. */
async function dropIfCancelled(team: string, target: TmuxTarget, res: LaunchOutcome): Promise<void> {
	if (!cancelledWakes.has(team) || !res.created) return;
	await killSession(target).catch(() => {});
	throw new WakeFailure(GAVE_UP, team);
}

const errorFailure = (reason: string): LaunchFailure => ({ kind: "error", reason: reason.slice(0, 2048) });

/** Failed wakes are typed for the Gateway. */
function sendWakeFailure(team: string, failure: LaunchFailure, extra: Record<string, unknown> = {}): void {
	safeSend({ type: "wake_result", team, success: false, error: launchFailureText(failure, team), failure, ...extra });
}

function sendLaunchResult(team: string, success: boolean, res: LaunchOutcome, extra: Record<string, unknown> = {}) {
	const { error } = launchError(res);
	if (!success) {
		sendWakeFailure(team, errorFailure(error ?? "the session did not come up"), { screen: res.screen, ...extra });
		return;
	}
	safeSend({ type: "wake_result", team, success, screen: res.screen, ...(error ? { error } : {}), ...extra });
}

function failWake(team: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[host-wake] failed to wake ${team}: ${message}`);
	sendWakeFailure(team, err instanceof WakeFailure ? err.failure : errorFailure(message));
}

async function wakeHarness(
	team: string,
	word: unknown,
	target: TmuxTarget,
	installed?: readonly SessionHarness[],
): Promise<SessionHarness> {
	const launch = installed ? resolveLaunchHarness(word, target, installed) : await launchHarnessFor(word, target);
	if ("refused" in launch) {
		throw new WakeFailure(
			launch.cli ? { kind: "cli", refusal: launch.cli } : { kind: "error", reason: launch.refused },
			team,
		);
	}
	sendWakeStage(team, "cli_found", { harness: launch.harness });
	if (cancelledWakes.has(team)) throw new WakeFailure(GAVE_UP, team);
	return launch.harness;
}

async function undoLaunch(target: TmuxTarget, res: LaunchOutcome): Promise<void> {
	if (res.created) await killSession(target);
}

/** Start the container if stopped, then launch. */
async function createInContainer(
	target: TmuxTarget,
	word: unknown,
	launch: (installed: readonly SessionHarness[]) => Promise<LaunchOutcome>,
): Promise<LaunchOutcome> {
	// Before any container starts.
	const placement = placementRefusal(word, target);
	if (placement) throw new Error(placement);
	if (!isTmuxName(target.name) || isHostSpawn(target.name)) throw new Error(`unknown project "${target.name}"`);
	const team = composeSessionName(target.name, target.sessionName);
	const projectPath = launchProjectPath(target.name, findProjectPath(target.name), team);
	try {
		const { value } = await devContainers.ensureUp(target.name, projectPath, launch, (res) =>
			undoLaunch(target, res),
		);
		return value;
	} catch (err) {
		if (err instanceof ContainerStopped) throw new WakeFailure({ kind: "stopped" }, team);
		if (!(err instanceof ContainerStartFailed)) throw err;
		console.error(`[host-op] ${target.name} container did not start: ${err.message}`);
		throw new WakeFailure({ kind: "container", spawn: target.name, projectPath }, team);
	}
}

/** A wake result's reason. */
function launchError(res: LaunchOutcome): { error?: string } {
	if (res.limit) return { error: `session limit hit${res.limit.detail ? ` (${res.limit.detail})` : ""}` };
	return res.error ? { error: res.error } : {};
}

async function handleWake(msg: WakeMessage): Promise<void> {
	// Both segments reach tmux and shell commands.
	const { project, session } = parseSessionName(msg.team);
	if (!isTmuxName(project) || !isTmuxName(session)) {
		console.error(`[host-wake] refusing wake of "${msg.team}": invalid project/session name`);
		sendWakeFailure(msg.team, errorFailure("invalid session name"));
		return;
	}
	// Before any container starts.
	const placement = placementRefusal(msg.harness, {
		kind: isHostSpawn(project) ? "host" : "devcontainer",
		name: project,
		sessionName: session,
	});
	if (placement) {
		console.error(`[host-wake] refusing wake of "${msg.team}": ${placement}`);
		sendWakeFailure(msg.team, errorFailure(placement));
		return;
	}
	// Every host spawn point lands here, never the devcontainer path.
	if (isHostSpawn(project)) {
		if (isReservedHostSession(session)) {
			console.error(`[host-wake] refusing wake of "${msg.team}": "${session}" is a reserved host session`);
			sendWakeFailure(msg.team, errorFailure("reserved host session"));
			return;
		}
		// Defence in depth behind the gateway's rule.
		if (!msg.sessionToken) {
			console.error(`[host-wake] refusing wake of "${msg.team}": no session token`);
			sendWakeFailure(msg.team, errorFailure("no session token"));
			return;
		}
		const target: TmuxTarget = { kind: "host", name: project, sessionName: session };
		if (msg.team === ASSISTANT_TEAM) {
			try {
				ensureAssistantWorkdir(msg.workdirHint);
			} catch (err) {
				const message = `could not create the assistant's folder: ${err instanceof Error ? err.message : String(err)}`;
				console.error(`[host-wake] refusing wake of "${msg.team}": ${message}`);
				sendWakeFailure(msg.team, errorFailure(message));
				return;
			}
		}
		// Refuses rather than falling back: a Linux path becomes a UNC cwd on Windows.
		const resolved = resolveSpawnWorkdir(project, msg.workdirHint);
		if ("error" in resolved) {
			console.error(`[host-wake] refusing wake of "${msg.team}": ${resolved.error}`);
			sendWakeFailure(msg.team, errorFailure(resolved.error));
			return;
		}
		try {
			const harness = await wakeHarness(msg.team, msg.harness, target);
			console.error(`[host-wake] starting ${HARNESS[harness].label} session ${msg.team}`);
			const res = await launchSession(target, {
				harness,
				resumeSessionId: msg.resumeSessionId,
				fresh: msg.fresh,
				sessionToken: msg.sessionToken,
				workdir: resolved.workdir,
				door: "wake",
			});
			await dropIfCancelled(msg.team, target, res);
			rememberPane(msg.team, target, res, msg.fresh === true);
			if (res.limit) {
				console.error(
					`[host-wake] ${msg.team} hit a usage limit: ${res.limit.headline ?? "no headline on screen"}`,
				);
			} else {
				console.error(`[host-wake] ${msg.team} ${res.live ? "is up" : "did not come up"}`);
			}
			sendLaunchResult(msg.team, res.live, res);
		} catch (err) {
			failWake(msg.team, err);
		}
		return;
	}

	const projectPath = msg.projectPath || findProjectPath(project);

	try {
		const resolved = launchProjectPath(project, projectPath, msg.team);
		const projectName = path.basename(resolved);
		console.error(`[host-wake] starting ${msg.team} at ${resolved}`);

		const target: TmuxTarget = { kind: "devcontainer", name: projectName, sessionName: session };
		// The Gateway's countdown waits out the build.
		sendWakeStage(msg.team, "building");
		const { pluginsProvisioned, value: res } = await devContainers
			.ensureUp(
				projectName,
				resolved,
				async (installed) => {
					sendWakeStage(msg.team, "container_up");
					const harness = await wakeHarness(msg.team, msg.harness, target, installed);
					console.error(`[host-wake] ${msg.team} container is up, starting ${HARNESS[harness].label}`);
					return launchSession(target, {
						harness,
						resumeSessionId: msg.resumeSessionId,
						fresh: msg.fresh,
						sessionToken: msg.sessionToken,
						door: "wake",
					});
				},
				(res) => undoLaunch(target, res),
			)
			.catch((err: unknown) => {
				if (err instanceof ContainerStopped) throw new WakeFailure({ kind: "stopped" }, msg.team);
				if (!(err instanceof ContainerStartFailed)) throw err;
				console.error(`[host-wake] ${msg.team} container did not start: ${err.message}`);
				throw new WakeFailure({ kind: "container", spawn: project, projectPath: resolved }, msg.team);
			});
		await dropIfCancelled(msg.team, target, res);
		rememberPane(msg.team, target, res, msg.fresh === true);
		console.error(`[host-wake] ${msg.team} session ${res.created ? "started" : "already running"}`);
		if (res.limit) {
			console.error(
				`[host-wake] ${msg.team} hit a usage limit: ${res.limit.headline ?? "no headline on screen"}`,
			);
		} else if (res.created) {
			console.error(`[host-wake] ${msg.team} ${res.ready ? "is ready" : "did not come up"}`);
		}

		// Zero captures means a dead launch.
		sendLaunchResult(msg.team, res.alive, res, { pluginsProvisioned });
	} catch (err) {
		failWake(msg.team, err);
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
		let workdir: string | undefined;
		if (target.kind === "host") {
			const resolved = resolveSpawnWorkdir(target.name, workdirHint);
			// Thrown, never a silent fallback.
			if ("error" in resolved) throw new Error(resolved.error);
			workdir = resolved.workdir;
		}
		const team = composeSessionName(target.name, target.sessionName);
		// A create supersedes a finished wake.
		madePanes.delete(team);
		const launch = async (installed?: readonly SessionHarness[]) => {
			const resolved = installed
				? resolveLaunchHarness(harness, target, installed)
				: await launchHarnessFor(harness, target);
			if ("refused" in resolved) {
				if (!resolved.cli) throw new Error(resolved.refused);
				throw new WakeFailure({ kind: "cli", refusal: resolved.cli }, team, resolved.refused);
			}
			safeSend({ type: "wake_stage", team, stage: "cli_found", harness: resolved.harness });
			return launchSession(target, {
				harness: resolved.harness,
				resumeSessionId,
				fresh,
				sessionToken,
				workdir,
				door: "create",
			});
		};
		const res = target.kind === "host" ? await launch() : await createInContainer(target, harness, launch);
		if (res.error) throw new Error(res.error);
		if (!res.created) return { created: false };
		return { created: true, ready: res.ready, alive: res.alive };
	},
	reloadPlugins: async (target) => {
		const pane = await peekPane(target);
		if (!isAgentReady(pane.ansi) || isAgentWorking(pane.ansi)) throw new Error("session is busy");
		spawnReloadPlugins(target);
		return { initiated: true };
	},
	killSession,
	containerStart: async (project) => devContainers.start(project, catalogProjectPath(project)),
	containerStop: async (project) => {
		const projectPath = catalogProjectPath(project);
		failStoppedLaunches(project);
		devContainers.stop(project, projectPath);
	},
	// A windows session browses through PowerShell.
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
		const failure = err instanceof WakeFailure ? err.failure : undefined;
		safeSend({
			type: "host_op_reply",
			reqId,
			ok: false,
			error: message,
			errorKind,
			...(failure ? { failure } : {}),
		});
	}
}
