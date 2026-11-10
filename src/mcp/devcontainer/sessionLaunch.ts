// One road from a session's facts to a running pane, for a wake and a create alike.

import { isAgentReady, isAgentWorking, type LimitNotice } from "../../shared/agent-screen.js";
import { ASSISTANT_TEAM } from "../../shared/assistant-session.js";
import { type CliRefusal, cliRefusalText, resolveCli } from "../../shared/cli-resolve.js";
import type { TmuxTarget } from "../../shared/host-op.js";
import { launchPlaceOf } from "../../shared/host-spawn.js";
import { type LaunchStatus, launchGoing, readLaunchStatus } from "../../shared/launch-status.js";
import {
	FIRST_LAUNCH_GREETING,
	foldHarness,
	HARNESS,
	type HarnessRow,
	type LaunchPlace,
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
	door: LaunchDoor;
}

/** A wake brings an existing pane back; a create leaves it. */
export type LaunchDoor = "wake" | "create";

/** Where a place runs its launchers. */
export interface LaunchSite {
	/** Runs the launcher. */
	runtime: string;
	/** Holds `dist/` and `launch/`. */
	root: string;
	/** As the pane sees it. */
	statusFile(target: TmuxTarget): string;
	readStatus(target: TmuxTarget): Promise<string | undefined>;
	clearStatus(target: TmuxTarget): Promise<void>;
}

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
	/** Null where no launcher runs. */
	sites: Record<LaunchPlace, LaunchSite | null>;
	/** Whether the pid runs on the pane's tty; undefined when the probe fails. */
	paneHolds(target: TmuxTarget, pid: number): Promise<boolean | undefined>;
	sleep(ms: number): Promise<void>;
	now(): number;
	log(line: string): void;
}

type Road = (deps: SessionLaunchDeps, target: TmuxTarget, facts: LaunchFacts) => Promise<LaunchOutcome>;

////////////////////////////////
//  Constants

/** Past the launcher's own bounds. */
export const LAUNCHER_READY_MS = 150_000;
const LAUNCHER_POLL_MS = 250;
/** With no status, past a slow shell startup. */
const NO_STATUS_PROBE_MS = 20_000;
const LAUNCHER_PROBE_MS = 2000;

////////////////////////////////
//  Functions & Helpers

export function targetPlace(target: TmuxTarget): LaunchPlace {
	return target.kind === "host" ? launchPlaceOf(target.name) : "container";
}

export function launchAt(target: TmuxTarget): { place: LaunchPlace; assistant: boolean } {
	return {
		place: targetPlace(target),
		assistant: composeSessionName(target.name, target.sessionName) === ASSISTANT_TEAM,
	};
}

/** Refused before anything starts: an unknown word, or a named CLI the place never runs. */
export function placementRefusal(word: unknown, target: TmuxTarget): string | undefined {
	const at = launchAt(target);
	const placed = (harness: SessionHarness) => {
		const refusal = launchRefusal(harness, at);
		return refusal ? `refusing to launch: ${refusal}` : undefined;
	};
	return foldHarness(readHarness(word), {
		named: placed,
		unnamed: placed,
		unpicked: () => undefined,
		unknown: (unknown) => olderThanSender(unknown),
	});
}

/** A launch's CLI once its place reports what is installed, or why it will not run. */
export function resolveLaunchHarness(
	word: unknown,
	target: TmuxTarget,
	installed: readonly SessionHarness[],
): { harness: SessionHarness } | { refused: string; cli?: CliRefusal } {
	const placement = placementRefusal(word, target);
	if (placement) return { refused: placement };
	const resolved = resolveCli(readHarness(word), installed);
	if ("refused" in resolved) {
		const refused = cliRefusalText(resolved.refused, composeSessionName(target.name, target.sessionName));
		return { refused, cli: resolved.refused };
	}
	return resolved;
}

function commandOf(deps: SessionLaunchDeps, target: TmuxTarget, facts: LaunchFacts): string {
	const site = deps.sites[targetPlace(target)];
	return buildLaunchCommand(target, {
		harness: facts.harness,
		resumeSessionId: facts.resumeSessionId,
		workdir: facts.workdir,
		sessionToken: facts.sessionToken,
		pathPrefix: deps.pathPrefix,
		...(site
			? {
					launcher: {
						runtime: site.runtime,
						root: site.root,
						statusFile: site.statusFile(target),
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
	if (facts.door === "create") return { created, ready: false, alive: true, live: true, screen: "" };
	// A container pane is read, not repaired.
	if (target.kind !== "host") {
		const screen = await deps.peekScreen(target).catch(() => "");
		return { created, ready: false, alive: true, live: true, screen };
	}
	// A stale composer outlives the CLI, so ask the OS first. A limit dialog is alive.
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

/** A status is only as live as its launcher on this pane. An unanswered probe keeps it. */
async function liveStatus(
	deps: SessionLaunchDeps,
	site: LaunchSite,
	target: TmuxTarget,
): Promise<LaunchStatus | "dead" | undefined> {
	const status = readLaunchStatus(await site.readStatus(target));
	if (!status || !launchGoing(status)) return status;
	return (await deps.paneHolds(target, status.pid)) === false ? "dead" : status;
}

/** The launcher's word, or why none will come. */
async function awaitLauncher(deps: SessionLaunchDeps, site: LaunchSite, target: TmuxTarget): Promise<Waited> {
	const start = deps.now();
	let nextProbe = start + LAUNCHER_PROBE_MS;
	let nextBareProbe = start + NO_STATUS_PROBE_MS;
	let goneOnce = false;
	const exited = async (): Promise<Waited> => ({
		kind: "exited",
		screen: await deps.peekScreen(target).catch(() => ""),
	});
	while (deps.now() < start + LAUNCHER_READY_MS) {
		await deps.sleep(LAUNCHER_POLL_MS);
		const status = readLaunchStatus(await site.readStatus(target));
		if (status?.state === "ready") return { kind: "ready" };
		if (status?.state === "failed") return { kind: "failed", error: status.error };
		if (status?.state === "exited") return exited();
		if (status) {
			if (deps.now() < nextProbe) continue;
			nextProbe = deps.now() + LAUNCHER_PROBE_MS;
			// Killed with no word.
			if ((await deps.paneHolds(target, status.pid)) === false) return exited();
			continue;
		}
		if (deps.now() < nextBareProbe) continue;
		nextBareProbe = deps.now() + LAUNCHER_PROBE_MS;
		if (!(await deps.hasSession(target))) return exited();
		// Not yet written. Twice, since a shell between commands reads as gone.
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

/** A live launcher keeps its pane. Undefined means relaunch. */
async function keptLauncher(
	deps: SessionLaunchDeps,
	site: LaunchSite,
	target: TmuxTarget,
): Promise<LaunchOutcome | undefined> {
	const status = await liveStatus(deps, site, target);
	if (status === "dead" || (status && !launchGoing(status))) return undefined;
	if (status?.state === "ready") return launcherOutcome(false, true);
	// Starting, or a shell not yet at its launcher.
	const waited = await awaitLauncher(deps, site, target);
	return waited.kind === "exited" ? undefined : waitedOutcome(false, waited);
}

/** Readiness is its launcher's word. Its greeting is the launcher's too. */
const viaLauncher: Road = async (deps, target, facts) => {
	const site = deps.sites[targetPlace(target)];
	if (!site)
		throw new Error(`refusing to launch: no ${HARNESS[facts.harness].label} launcher where this session runs`);
	const command = commandOf(deps, target, facts);
	if (await deps.hasSession(target)) {
		if (facts.door === "create") return { created: false, ready: false, alive: true, live: true, screen: "" };
		const kept = await keptLauncher(deps, site, target);
		if (kept) return kept;
		await deps.killSession(target);
	}
	// The only delete: a launcher leaves its last word.
	await site.clearStatus(target);
	const { created } = await deps.ensureSession(target, command);
	return waitedOutcome(created, await awaitLauncher(deps, site, target));
};

const ROADS: Record<HarnessRow["road"]["kind"], Road> = { pane: viaPane, api: viaLauncher };

export function createSessionLaunch(deps: SessionLaunchDeps) {
	return (target: TmuxTarget, facts: LaunchFacts): Promise<LaunchOutcome> => {
		const resumeSessionId = resumableId(facts.harness, facts.resumeSessionId);
		return ROADS[HARNESS[facts.harness].road.kind](deps, target, { ...facts, resumeSessionId });
	};
}

export type SessionLaunch = ReturnType<typeof createSessionLaunch>;
