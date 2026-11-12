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
	type DaemonHostOp,
	HostClaudeCancelOpSchema,
	HostClaudeRunOpSchema,
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
import { LaunchIdSchema, WakeCancelFrameSchema, WakeResultAckFrameSchema } from "../../shared/schemasWake.js";
import {
	type LaunchPlace,
	type PaneRoad,
	paneRoad,
	SESSION_HARNESSES,
	type SessionHarness,
} from "../../shared/session-harness.js";
import { composeSessionName, parseSessionName } from "../../shared/session-id.js";
import { ASKPASS_BUNDLE, installAskpassWrapper, removeAskpassWrapper } from "../../shared/vault-askpass-wrapper.js";
import { appendBuildTranscript } from "./buildTranscript.js";
import { createClaudeRunner } from "./claudeRunner.js";
import { CodexDaemonService } from "./codexDaemonService.js";
import { ExecutionTargetManager, targetLogger } from "./codexTargets.js";
import { CONTAINER_HOME, containerLaunchSite, createRuntimePlacer } from "./containerSite.js";
import { containerFor, DevContainers, docker } from "./containers.js";
import {
	type CompactionFollow,
	compactionEventsPath,
	createCompactionFollower,
	execEventsFile,
	localEventsFile,
} from "./copilotCompaction.js";
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
	scanProjectFolders,
	setProjectDirs,
} from "./hostResolve.js";
import { createKasaScanner } from "./kasaScan.js";
import { createLaunchLane, WakeFailure } from "./launchLane.js";
import { PromptOccurrences, seePrompt } from "./permissionPrompt.js";
import { provisionPlugins } from "./pluginProvisioning.js";
import { PresenceScheduler, readWatch, type WatchEntry } from "./presenceScheduler.js";
import { answerPrompt, continueAfterLimit, dismissSurvey, type PromptSight, stopAutoDeny } from "./promptAnswer.js";
import { spawnReloadPlugins } from "./reloadPlugins.js";
import { createSessionLaunch, type LaunchSite, launchAt } from "./sessionLaunch.js";
import {
	awaitReady,
	ensureSession,
	execInPlace,
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
	const { projects, unaddressable } = scanProjectFolders();
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
		// Every stage and result names its launch.
		launchIds: true,
		// FIXME 2026-11-23: drop both, once every Gateway reads `harnessSpawns`.
		claudeSpawns: harnessSpawns.claude,
		copilotSpawns: harnessSpawns.copilot,
	});
	console.error(
		`[host-wake] sent catalog with ${projects.length} projects` +
			(hostSpawns.length ? ` and host spawn points: ${hostSpawns.join(", ")}` : ""),
	);
	if (unaddressable.length > 0) {
		console.error(`[host-wake] left out, rename to lowercase letters, digits, - or _: ${unaddressable.join(", ")}`);
	}
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

		// Results replay until acked.
		sendCatalog()
			.catch((err) => console.error("[host-daemon] catalog failed:", err))
			.finally(() => {
				launchLane.replayStages();
				launchLane.replayResults();
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

		if (msg.type === "wake" && typeof msg.team === "string") {
			const launchId = LaunchIdSchema.optional().safeParse(msg.launchId);
			if (!launchId.success) {
				console.error(`[host-wake] dropping wake of "${msg.team}": malformed launch id`);
			} else {
				try {
					handleWake({ ...(msg as unknown as WakeMessage), launchId: launchId.data });
				} catch (err) {
					console.error("[host-wake] dispatch error:", err);
					refuseWake(msg.team, launchId.data, err instanceof Error ? err.message : String(err));
				}
			}
		}

		if (msg.type === "wake_cancel") {
			const cancel = WakeCancelFrameSchema.safeParse(msg);
			if (cancel.success) launchLane.cancel(cancel.data.team, cancel.data.launchId);
		}

		if (msg.type === "wake_result_ack") {
			const ack = WakeResultAckFrameSchema.safeParse(msg);
			if (ack.success) launchLane.ack(ack.data.launchId);
		}

		if (msg.type === "host_op" && typeof msg.reqId === "string") {
			void handleHostOp(msg.reqId as string, msg.op as DaemonHostOp).catch((e) =>
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
					follows.push({ team: watch.team, copilotSessionId: watch.sessionId, place: target });
				}
			}
			void presenceScheduler.setWatches(entries);
			compactionFollower
				.setFollows(follows)
				.catch((err) => console.error("[presence] compaction follow failed:", err));
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
	/** Absent from an older Gateway. */
	launchId?: string;
	/** Create intent; absent is wake. */
	door?: unknown;
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

/** The checkout's version. */
function launchVersion(): string | null {
	try {
		const version = JSON.parse(fs.readFileSync(path.join(LAUNCH_ROOT, "package.json"), "utf8")).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

const LAUNCH_VERSION = launchVersion();

const LAUNCH_SITES: Record<LaunchPlace, LaunchSite | null> = {
	host: hostLaunchSite(),
	windows: null,
	container: LAUNCH_VERSION ? containerLaunchSite(LAUNCH_VERSION, (target, argv) => execInPlace(target, argv)) : null,
};

/** Copies the runtime into the container. */
async function placeContainerRuntime(project: string, signal?: AbortSignal): Promise<void> {
	if (!LAUNCH_VERSION) return;
	const where = { kind: "devcontainer" as const, name: project };
	const placed = await placeRuntime({
		exec: (argv) => execInPlace(where, argv, RUNTIME_COPY_MS, signal),
		docker: (args) => docker(args, RUNTIME_COPY_MS, signal),
		container: containerFor(project),
		source: LAUNCH_ROOT,
		version: LAUNCH_VERSION,
	});
	if (placed === "copied") console.error(`[devcontainer] ${project}: runtime ${LAUNCH_VERSION} copied in`);
}

const placeRuntime = createRuntimePlacer();

const RUNTIME_COPY_MS = 60_000;
// Bounded inside the container too.
const PROVISION_INSIDE_S = 300;
const PROVISION_MS = (PROVISION_INSIDE_S + 10) * 1000;

/** One provisioning script with shell setup. */
function provisionScript(project: string, script: string, signal: AbortSignal): Promise<boolean> {
	const argv = ["timeout", String(PROVISION_INSIDE_S), "bash", "-c", `source ~/.bashrc >/dev/null 2>&1; ${script}`];
	return execInPlace({ kind: "devcontainer", name: project }, argv, PROVISION_MS, signal).then(
		() => true,
		() => false,
	);
}

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
	look: async (project, signal) => {
		await placeContainerRuntime(project, signal).catch((err) =>
			console.error(`[devcontainer] ${project}: runtime not placed: ${err instanceof Error ? err.message : err}`),
		);
		return installedAt({ kind: "devcontainer", name: project }, { place: "container", assistant: false });
	},
	provision: (project, installed, signal) =>
		provisionPlugins(
			installed,
			(script) => provisionScript(project, script, signal),
			(line) => {
				console.error(`[devcontainer] ${project}: ${line}`);
				appendBuildTranscript(project, `[plugins] ${line}\n`);
			},
		),
	catalog: scanDevcontainerProjects,
	onChange: (containers) => safeSend({ type: "containers", containers }),
});

/** A catalog project's path; throws for any other. */
function catalogProjectPath(project: string): string {
	if (!isTmuxName(project) || isHostSpawn(project)) throw new Error(`unknown project "${project}"`);
	return resolveProject(findProjectPath(project));
}

// Launch road and tmux primitives.
const launchLane = createLaunchLane({
	launch: createSessionLaunch({
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
	}),
	kill: killSession,
	installed: (target) => installedAt(target, launchAt(target)),
	project: (name, hint) => {
		const projectPath = hint || findProjectPath(name);
		try {
			return { path: resolveProject(projectPath) };
		} catch (err) {
			return { path: projectPath, refused: err instanceof Error ? err.message : String(err) };
		}
	},
	generation: (project) => devContainers.generation(project),
	ensureUp: (project, projectPath, generation, then, undo) =>
		devContainers.ensureUp(project, projectPath, generation, then, undo),
	send: safeSend,
	now: () => Date.now(),
	uuid: () => crypto.randomUUID(),
	log: (line) => console.error(`[host-wake] ${line}`),
});

function refuseWake(team: string, launchId: string | undefined, reason: string): void {
	console.error(`[host-wake] refusing wake of "${team}": ${reason}`);
	launchLane.refuse(team, launchId, reason);
}

/** Local checks, then the lane. */
function handleWake(msg: WakeMessage): void {
	const refuse = (reason: string) => refuseWake(msg.team, msg.launchId, reason);
	// Both segments reach tmux and shell commands.
	const { project, session } = parseSessionName(msg.team);
	if (!isTmuxName(project) || !isTmuxName(session)) {
		refuse("invalid session name");
		return;
	}
	// Never guessed as a wake.
	if (msg.door !== undefined && msg.door !== "create" && msg.door !== "wake") {
		refuse(`unknown launch door "${String(msg.door).slice(0, 32)}": this build is older than its sender`);
		return;
	}
	const door = msg.door ?? "wake";
	const request = {
		harness: msg.harness,
		resumeSessionId: msg.resumeSessionId,
		fresh: msg.fresh,
		sessionToken: msg.sessionToken,
		launchId: msg.launchId,
	};
	if (!isHostSpawn(project)) {
		const target: TmuxTarget = { kind: "devcontainer", name: project, sessionName: session };
		launchLane.wake(msg.team, { ...request, target, projectPath: msg.projectPath }, door);
		return;
	}
	if (isReservedHostSession(session)) {
		refuse("reserved host session");
		return;
	}
	// Defence in depth behind the gateway's rule.
	if (!msg.sessionToken) {
		refuse("no session token");
		return;
	}
	if (msg.team === ASSISTANT_TEAM) {
		try {
			ensureAssistantWorkdir(msg.workdirHint);
		} catch (err) {
			refuse(`could not create the assistant's folder: ${err instanceof Error ? err.message : err}`);
			return;
		}
	}
	// No fallback: a Linux path becomes a UNC cwd on Windows.
	const resolved = resolveSpawnWorkdir(project, msg.workdirHint);
	if ("error" in resolved) {
		refuse(resolved.error);
		return;
	}
	const target: TmuxTarget = { kind: "host", name: project, sessionName: session };
	launchLane.wake(msg.team, { ...request, target, workdir: resolved.workdir }, door);
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
	// FIXME 2026-11-24: drop, once every Gateway creates by wake.
	createSession: async ({ target, workdirHint, resumeSessionId, sessionToken, harness, fresh, launchId }) => {
		let workdir: string | undefined;
		if (target.kind === "host") {
			const resolved = resolveSpawnWorkdir(target.name, workdirHint);
			// Thrown, never a silent fallback.
			if ("error" in resolved) throw new Error(resolved.error);
			workdir = resolved.workdir;
		} else if (!isTmuxName(target.name) || isHostSpawn(target.name)) {
			throw new Error(`unknown project "${target.name}"`);
		}
		const tagged = LaunchIdSchema.optional().safeParse(launchId);
		if (!tagged.success) throw new Error("malformed launch id");
		return launchLane.create({
			target,
			harness,
			resumeSessionId,
			sessionToken,
			fresh,
			workdir,
			launchId: tagged.data,
		});
	},
	reloadPlugins: async (target) => {
		const pane = await peekPane(target);
		if (!isAgentReady(pane.ansi) || isAgentWorking(pane.ansi)) throw new Error("session is busy");
		spawnReloadPlugins(target);
		return { initiated: true };
	},
	// Close and Forget wait behind a launch on the pane.
	killSession: (target) => launchLane.kill(target),
	containerStart: async (project) => devContainers.start(project, catalogProjectPath(project)),
	containerStop: async (project) => {
		const projectPath = catalogProjectPath(project);
		launchLane.stop(project);
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
	file: ({ copilotSessionId, place }) =>
		place.kind === "host"
			? localEventsFile(compactionEventsPath(os.homedir(), copilotSessionId))
			: execEventsFile(
					(argv) => execInPlace(place, argv),
					compactionEventsPath(CONTAINER_HOME, copilotSessionId),
				),
	onChange: (team, compacting) => presenceScheduler.setOverlay(team, compacting ? { compacting: true } : undefined),
});

async function handleHostOp(reqId: string, op: DaemonHostOp): Promise<void> {
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
