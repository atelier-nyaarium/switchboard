// One road from a session's facts to a running pane, for a wake and a create alike.

import path from "node:path";
import { isAgentReady, isAgentWorking, type LimitNotice } from "../../shared/agent-screen.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import type { TmuxTarget } from "../../shared/host-op.js";
import { launchPlaceOf } from "../../shared/host-spawn.js";
import { type LaunchStatus, readLaunchStatus } from "../../shared/launch-status.js";
import {
	FIRST_LAUNCH_GREETING,
	foldHarness,
	HARNESS,
	type HarnessRow,
	launchRefusal,
	olderThanSender,
	readHarness,
	resumableId,
	type SessionHarness,
} from "../../shared/session-harness.js";
import { composeSessionName } from "../../shared/session-id.js";
import { buildLaunchCommand, shouldGreetLaunch } from "./hostResolve.js";
import type { PaneAgentState, ReadyAnswer } from "./tmuxCore.js";

////////////////////////////////
//  Interfaces & Types

export interface LaunchFacts {
	harness: SessionHarness;
	resumeSessionId?: string;
	/** Its session has never confirmed. */
	fresh?: boolean;
	sessionToken?: string;
	/** Already resolved; a container has none. */
	workdir?: string;
	existing: ExistingPane;
}

/**
 * What a launch does with a pane already there: `repair` relaunches one whose CLI is gone, `peek`
 * reads a pane's screen, `leave` touches nothing. A launcher-run pane is read only on `repair`.
 */
export type ExistingPane = "repair" | "peek" | "leave";

export interface LaunchOutcome {
	created: boolean;
	/** At its composer, or its server answered. */
	ready: boolean;
	alive: boolean;
	/** Ready or mid-turn. */
	live: boolean;
	screen: string;
	limit?: LimitNotice;
	error?: string;
}

export interface SessionLaunchDeps {
	hasSession(target: TmuxTarget): Promise<boolean>;
	ensureSession(target: TmuxTarget, command: string): Promise<{ created: boolean }>;
	killSession(target: TmuxTarget): Promise<unknown>;
	awaitReady(target: TmuxTarget): Promise<ReadyAnswer>;
	paneAgentState(target: TmuxTarget): Promise<PaneAgentState>;
	reattachStep(seen: ReadyAnswer | undefined): "relaunch" | "recheck" | "keep";
	peekScreen(target: TmuxTarget): Promise<string>;
	sendText(target: TmuxTarget, text: string): Promise<unknown>;
	/** The daemon's bun directory. */
	pathPrefix: string;
	/** Null when this machine has no launcher bundle. */
	launcher: { runtime: string; root: string; statusDir: string } | null;
	readFile(file: string): string | undefined;
	removeFile(file: string): void;
	/** Whether a launcher's process still runs. */
	isAlive(pid: number): boolean;
	sleep(ms: number): Promise<void>;
	now(): number;
	log(line: string): void;
}

type Road = (deps: SessionLaunchDeps, target: TmuxTarget, facts: LaunchFacts) => Promise<LaunchOutcome>;

////////////////////////////////
//  Constants

/** Past the launcher's own bounds. */
const LAUNCHER_READY_MS = 150_000;
const LAUNCHER_POLL_MS = 250;
/** With no status, past a slow shell startup. */
const NO_STATUS_PROBE_MS = 20_000;
const LAUNCHER_PROBE_MS = 2000;

////////////////////////////////
//  Functions & Helpers

/** A launch's CLI, or why this daemon will not run it there. */
export function resolveLaunchHarness(
	word: unknown,
	target: TmuxTarget,
): { harness: SessionHarness } | { refused: string } {
	const at = {
		place: target.kind === "host" ? launchPlaceOf(target.name) : ("container" as const),
		assistant: composeSessionName(target.name, target.sessionName) === ASSISTANT_TEAM,
	};
	const placed = (harness: SessionHarness) => {
		const refusal = launchRefusal(harness, at);
		return refusal ? { refused: `refusing to launch: ${refusal}` } : { harness };
	};
	return foldHarness(readHarness(word), {
		named: placed,
		unnamed: placed,
		unknown: (unknown) => ({ refused: olderThanSender(unknown) }),
	});
}

function statusFileOf(deps: SessionLaunchDeps, target: TmuxTarget): string | undefined {
	if (!deps.launcher) return undefined;
	return path.join(deps.launcher.statusDir, `${composeSessionName(target.name, target.sessionName)}.json`);
}

function commandOf(deps: SessionLaunchDeps, target: TmuxTarget, facts: LaunchFacts): string {
	const statusFile = statusFileOf(deps, target);
	return buildLaunchCommand(target, {
		harness: facts.harness,
		resumeSessionId: facts.resumeSessionId,
		workdir: facts.workdir,
		sessionToken: facts.sessionToken,
		pathPrefix: deps.pathPrefix,
		...(deps.launcher && statusFile
			? {
					launcher: {
						runtime: deps.launcher.runtime,
						root: deps.launcher.root,
						statusFile,
						greet: shouldGreetLaunch({
							created: true,
							ready: true,
							resumeSessionId: facts.resumeSessionId,
							fresh: facts.fresh,
						}),
					},
				}
			: {}),
	});
}

// Never blocks the reply.
function greetTyped(deps: SessionLaunchDeps, target: TmuxTarget, facts: LaunchFacts, created: boolean, ready: boolean) {
	if (!shouldGreetLaunch({ created, ready, resumeSessionId: facts.resumeSessionId, fresh: facts.fresh })) return;
	deps.log(`greeting freshly created session ${target.sessionName}`);
	void deps.sendText(target, FIRST_LAUNCH_GREETING).catch((error) => {
		deps.log(`failed to greet ${target.sessionName}: ${error instanceof Error ? error.message : String(error)}`);
	});
}

const paneOutcome = (created: boolean, seen: ReadyAnswer): LaunchOutcome => ({
	created,
	ready: seen.ready,
	alive: seen.alive,
	live: seen.ready || isAgentWorking(seen.screen),
	screen: seen.screen,
	...(seen.limit ? { limit: seen.limit } : {}),
});

/** Readiness is read off the screen. */
const viaPane: Road = async (deps, target, facts) => {
	const command = commandOf(deps, target, facts);
	const { created } = await deps.ensureSession(target, command);
	if (created) {
		const seen = await deps.awaitReady(target);
		greetTyped(deps, target, facts, created, seen.ready);
		return paneOutcome(created, seen);
	}
	if (facts.existing !== "repair") {
		const screen = facts.existing === "peek" ? await deps.peekScreen(target).catch(() => "") : "";
		return { created, ready: false, alive: true, live: true, screen };
	}
	// `exec bash` outlives the CLI, and its last frame still shows a composer, so the OS is asked
	// first. A limit dialog is alive: relaunching would discard it and hit the same limit.
	const seen = (await deps.paneAgentState(target)) === "gone" ? undefined : await deps.awaitReady(target);
	let step = deps.reattachStep(seen);
	let kept = seen;
	if (step === "recheck") {
		const recheck = await deps.peekScreen(target).catch(() => seen?.screen ?? "");
		const ready = isAgentReady(recheck);
		// A sub-second transition, after all.
		if (ready || isAgentWorking(recheck)) kept = { alive: true, ready, screen: recheck };
		else step = "relaunch";
	}
	if (step === "relaunch") {
		await deps.killSession(target);
		await deps.ensureSession(target, command);
		kept = await deps.awaitReady(target);
	}
	if (!kept) throw new Error("session readiness unavailable");
	// The first `ensureSession` decides, not the relaunch.
	greetTyped(deps, target, facts, created, kept.ready);
	return paneOutcome(created, kept);
};

const launcherOutcome = (created: boolean, ready: boolean, error?: string, screen = ""): LaunchOutcome => ({
	created,
	ready,
	alive: ready,
	live: ready,
	screen,
	...(error ? { error } : {}),
});

type Waited =
	| { kind: "ready" }
	| { kind: "failed"; error: string }
	/** Its launcher is gone with no word. */
	| { kind: "exited"; screen: string }
	| { kind: "timeout" };

const EXITED = "the session's launcher exited without starting";

/** A status is only as live as the launcher that wrote it. */
function liveStatus(deps: SessionLaunchDeps, statusFile: string): LaunchStatus | "dead" | undefined {
	const status = readLaunchStatus(deps.readFile(statusFile));
	if (!status || status.state === "failed") return status;
	return deps.isAlive(status.pid) ? status : "dead";
}

/** The launcher's word, or why none will come. */
async function awaitLauncher(deps: SessionLaunchDeps, target: TmuxTarget, statusFile: string): Promise<Waited> {
	const start = deps.now();
	let nextProbe = start + NO_STATUS_PROBE_MS;
	let goneOnce = false;
	const exited = async (): Promise<Waited> => ({
		kind: "exited",
		screen: await deps.peekScreen(target).catch(() => ""),
	});
	while (deps.now() < start + LAUNCHER_READY_MS) {
		await deps.sleep(LAUNCHER_POLL_MS);
		const status = liveStatus(deps, statusFile);
		if (status === "dead") return exited();
		if (status?.state === "ready") return { kind: "ready" };
		if (status?.state === "failed") return { kind: "failed", error: status.error };
		if (status || deps.now() < nextProbe) continue;
		nextProbe = deps.now() + LAUNCHER_PROBE_MS;
		if (!(await deps.hasSession(target))) return exited();
		// No status: never written, or removed on exit. Twice, since a shell between commands reads as gone.
		const gone = (await deps.paneAgentState(target)) === "gone";
		if (gone && goneOnce) return exited();
		goneOnce = gone;
	}
	return { kind: "timeout" };
}

function waitedOutcome(created: boolean, waited: Waited): LaunchOutcome {
	switch (waited.kind) {
		case "ready":
			return launcherOutcome(created, true);
		case "failed":
			return launcherOutcome(created, false, waited.error);
		case "exited":
			return launcherOutcome(created, false, EXITED, waited.screen);
		case "timeout":
			return launcherOutcome(created, false, "the session's server did not start in time");
	}
}

/**
 * A launcher still running keeps its pane, so a wake while its plugin reconnects loses no turn. It
 * restarts a dead plugin itself, and reports `failed` once its server or UI is gone. Undefined means
 * relaunch.
 */
async function keptLauncher(
	deps: SessionLaunchDeps,
	target: TmuxTarget,
	statusFile: string,
): Promise<LaunchOutcome | undefined> {
	const status = liveStatus(deps, statusFile);
	if (status === "dead" || status?.state === "failed") return undefined;
	if (status?.state === "ready") return launcherOutcome(false, true);
	// Starting, or a shell not yet at its launcher.
	const waited = await awaitLauncher(deps, target, statusFile);
	return waited.kind === "exited" ? undefined : waitedOutcome(false, waited);
}

/** Readiness is its launcher's word. Its greeting is the launcher's too. */
const viaLauncher: Road = async (deps, target, facts) => {
	const statusFile = statusFileOf(deps, target);
	if (!statusFile) throw new Error(`refusing to launch: no ${HARNESS[facts.harness].label} launcher on this machine`);
	const command = commandOf(deps, target, facts);
	if (await deps.hasSession(target)) {
		if (facts.existing !== "repair") return { created: false, ready: false, alive: true, live: true, screen: "" };
		const kept = await keptLauncher(deps, target, statusFile);
		if (kept) return kept;
		await deps.killSession(target);
	}
	// A status from a launcher that never cleaned up.
	deps.removeFile(statusFile);
	const { created } = await deps.ensureSession(target, command);
	return waitedOutcome(created, await awaitLauncher(deps, target, statusFile));
};

const ROADS: Record<HarnessRow["road"]["kind"], Road> = { pane: viaPane, api: viaLauncher };

export function createSessionLaunch(deps: SessionLaunchDeps) {
	return (target: TmuxTarget, facts: LaunchFacts): Promise<LaunchOutcome> => {
		const resumeSessionId = resumableId(facts.harness, facts.resumeSessionId);
		return ROADS[HARNESS[facts.harness].road.kind](deps, target, { ...facts, resumeSessionId });
	};
}

export type SessionLaunch = ReturnType<typeof createSessionLaunch>;
