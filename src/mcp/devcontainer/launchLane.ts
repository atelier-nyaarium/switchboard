import path from "node:path";
import type { TmuxTarget } from "../../shared/host-op.js";
import { type LaunchFailure, launchFailureText } from "../../shared/launch-notice.js";
import type { SessionHarness } from "../../shared/session-harness.js";
import { composeSessionName } from "../../shared/session-id.js";
import { ContainerStartFailed, ContainerStopped } from "./containers.js";
import {
	type LaunchDoor,
	type LaunchFacts,
	type LaunchOutcome,
	placementRefusal,
	resolveLaunchHarness,
} from "./sessionLaunch.js";

////////////////////////////////
//  Interfaces & Types

/** A launch as a door hands it in. A container target's `name` is its project. */
export interface LaunchRequest {
	target: TmuxTarget;
	/** A CLI word, unchecked. */
	harness: unknown;
	resumeSessionId?: string;
	fresh?: true;
	sessionToken?: string;
	/** Host kinds only, resolved. */
	workdir?: string;
	/** Containers: where a wake says the project is. */
	projectPath?: string;
}

export interface CreateAnswer {
	created: boolean;
	ready?: boolean;
	alive?: boolean;
}

export interface LaunchLaneDeps {
	launch(target: TmuxTarget, facts: LaunchFacts): Promise<LaunchOutcome>;
	kill(target: TmuxTarget): Promise<void>;
	/** What a host-kind place runs. */
	installed(target: TmuxTarget): Promise<SessionHarness[]>;
	/** A project's path, and why it cannot run when it cannot. */
	project(name: string, hint?: string): { path: string; refused?: string };
	generation(project: string): number;
	ensureUp<T>(
		project: string,
		projectPath: string,
		generation: number,
		then: (installed: SessionHarness[]) => Promise<T>,
		undo: (value: T) => Promise<unknown>,
	): Promise<{ pluginsProvisioned: boolean; value: T }>;
	send(frame: Record<string, unknown>): void;
	now(): number;
	log(line: string): void;
}

/** A launch that will not come up, as the Gateway reads it. */
export class WakeFailure extends Error {
	constructor(
		readonly failure: LaunchFailure,
		team: string,
		message = launchFailureText(failure, team),
	) {
		super(message);
	}
}

/** `typed`: a create carries the failure too. */
type Refusal = { ok: false; failure: LaunchFailure; text: string; typed: boolean };

type Settled = { ok: true; res: LaunchOutcome; pluginsProvisioned?: boolean } | Refusal;

interface LaunchUnit {
	kind: "launch";
	door: LaunchDoor;
	team: string;
	target: TmuxTarget;
	/** Containers only. */
	project?: string;
	projectPath?: string;
	started: boolean;
	settled: boolean;
	/** The Gateway gave up on its wake. */
	cancelled: boolean;
	/** A create took its outcome, so a cancel leaves the pane. */
	joinedCreate: boolean;
	done: Promise<Settled>;
	settle(result: Settled): void;
	run(): Promise<void>;
}

interface KillUnit {
	kind: "kill";
	started: boolean;
	settled: boolean;
	run(): Promise<void>;
}

type Unit = LaunchUnit | KillUnit;

/** A failure this lane words. */
class Failed extends Error {
	constructor(
		readonly failure: LaunchFailure,
		text: string,
		readonly typed: boolean,
	) {
		super(text);
	}
}

////////////////////////////////
//  Constants

export const GAVE_UP: LaunchFailure = { kind: "error", reason: "the Gateway gave up on this launch" };

// A Gateway record outlives `container_up` by 10 minutes.
export const LATE_CANCEL_MS = 15 * 60_000;

////////////////////////////////
//  Functions & Helpers

/** The pane a target names. Every host-kind spawn point shares one tmux server. */
export function physicalPane(target: TmuxTarget): string {
	return target.kind === "host" ? `host:${target.sessionName}` : `container:${target.name}:${target.sessionName}`;
}

export const errorFailure = (reason: string): LaunchFailure => ({ kind: "error", reason: reason.slice(0, 2048) });

/** Every failed wake is typed, so the Gateway renders it. */
export function failedWakeFrame(
	team: string,
	failure: LaunchFailure,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { type: "wake_result", team, success: false, error: launchFailureText(failure, team), failure, ...extra };
}

function refusal(failure: LaunchFailure, team: string, typed: boolean, text = launchFailureText(failure, team)) {
	return { ok: false, failure, text, typed } satisfies Refusal;
}

function launchError(res: LaunchOutcome): string | undefined {
	if (res.limit) return `session limit hit${res.limit.detail ? ` (${res.limit.detail})` : ""}`;
	return res.error;
}

function createAnswer(result: Settled, team: string): CreateAnswer {
	if (!result.ok) throw result.typed ? new WakeFailure(result.failure, team, result.text) : new Error(result.text);
	const { res } = result;
	if (res.error) throw new Error(res.error);
	if (!res.created) return { created: false };
	return { created: true, ready: res.ready, alive: res.alive };
}

/** One queue per physical pane. A request joins the tail when that answers it. */
export function createLaunchLane(deps: LaunchLaneDeps) {
	const lanes = new Map<string, Unit[]>();
	/** Each running wake's last stage frame, by team. */
	const stages = new Map<string, { unit: LaunchUnit; frame: Record<string, unknown> }>();
	/** Finished never-confirmed wakes whose launch made the pane. */
	const madePanes = new Map<string, { target: TmuxTarget; pane: string; at: number }>();

	function enqueue(pane: string, unit: Unit): void {
		for (const [team, made] of madePanes) if (made.pane === pane) madePanes.delete(team);
		const units = lanes.get(pane);
		if (units) {
			units.push(unit);
			return;
		}
		lanes.set(pane, [unit]);
		pump(pane).catch((err) => deps.log(`lane ${pane} failed: ${err instanceof Error ? err.message : err}`));
	}

	async function pump(pane: string): Promise<void> {
		const units = lanes.get(pane);
		while (units && units.length > 0) {
			const unit = units[0] as Unit;
			if (!unit.settled) {
				unit.started = true;
				await unit.run();
			}
			units.shift();
		}
		lanes.delete(pane);
	}

	function liveWakes(team: string): LaunchUnit[] {
		const found: LaunchUnit[] = [];
		for (const units of lanes.values()) {
			for (const unit of units) {
				if (unit.kind === "launch" && unit.door === "wake" && unit.team === team && !unit.settled)
					found.push(unit);
			}
		}
		return found;
	}

	function joinable(pane: string, door: LaunchDoor, team: string): LaunchUnit | undefined {
		const tail = lanes.get(pane)?.at(-1);
		if (tail?.kind !== "launch" || tail.settled || tail.cancelled || tail.team !== team) return undefined;
		return tail.door === door || (door === "create" && tail.door === "wake") ? tail : undefined;
	}

	function sendStage(unit: LaunchUnit, stage: string, extra: Record<string, unknown> = {}): void {
		const frame = { type: "wake_stage", team: unit.team, stage, ...extra };
		stages.set(unit.team, { unit, frame });
		deps.send(frame);
	}

	function settledOf(unit: LaunchUnit, err: unknown): Settled {
		if (err instanceof Failed) return refusal(err.failure, unit.team, err.typed, err.message);
		if (err instanceof ContainerStopped) return refusal({ kind: "stopped" }, unit.team, true);
		if (err instanceof ContainerStartFailed) {
			deps.log(`${unit.team} container did not start: ${err.message}`);
			const spawn = unit.project ?? unit.target.name;
			return refusal({ kind: "container", spawn, projectPath: unit.projectPath }, unit.team, true);
		}
		const message = err instanceof Error ? err.message : String(err);
		return refusal(errorFailure(message), unit.team, false, message);
	}

	/** The launch itself, as the unit's door asks it. */
	async function body(unit: LaunchUnit, req: LaunchRequest, generation: number): Promise<Settled> {
		const wake = unit.door === "wake";
		const pick = (installed: readonly SessionHarness[]): SessionHarness => {
			const resolved = resolveLaunchHarness(req.harness, unit.target, installed);
			if ("refused" in resolved) {
				if (!resolved.cli) throw new Failed(errorFailure(resolved.refused), resolved.refused, false);
				throw new Failed({ kind: "cli", refusal: resolved.cli }, resolved.refused, true);
			}
			const harness = resolved.harness;
			// Only a wake's stage is replayed.
			if (wake) sendStage(unit, "cli_found", { harness });
			else deps.send({ type: "wake_stage", team: unit.team, stage: "cli_found", harness });
			if (unit.cancelled && !unit.joinedCreate) {
				throw new Failed(GAVE_UP, launchFailureText(GAVE_UP, unit.team), false);
			}
			return harness;
		};
		const facts = (harness: SessionHarness): LaunchFacts => ({
			harness,
			resumeSessionId: req.resumeSessionId,
			fresh: req.fresh,
			sessionToken: req.sessionToken,
			workdir: req.workdir,
			door: unit.door,
		});
		if (unit.target.kind === "host") {
			const harness = pick(await deps.installed(unit.target));
			return { ok: true, res: await deps.launch(unit.target, facts(harness)) };
		}
		if (wake) sendStage(unit, "building");
		const { pluginsProvisioned, value } = await deps.ensureUp(
			unit.project as string,
			unit.projectPath as string,
			generation,
			async (installed) => {
				if (wake) sendStage(unit, "container_up");
				return deps.launch(unit.target, facts(pick(installed)));
			},
			async (res) => {
				if (res.created) await deps.kill(unit.target);
			},
		);
		return { ok: true, res: value, pluginsProvisioned };
	}

	function replyWake(unit: LaunchUnit, result: Settled, fresh: boolean): void {
		if (stages.get(unit.team)?.unit === unit) stages.delete(unit.team);
		if (unit.cancelled) {
			deps.send(failedWakeFrame(unit.team, GAVE_UP));
			return;
		}
		if (!result.ok) {
			deps.log(`failed to wake ${unit.team}: ${result.text}`);
			deps.send(failedWakeFrame(unit.team, result.failure));
			return;
		}
		const { res } = result;
		if (res.created && fresh) {
			madePanes.set(unit.team, { target: unit.target, pane: physicalPane(unit.target), at: deps.now() });
		}
		// Zero captures means a dead container launch.
		const success = unit.target.kind === "host" ? res.live : res.alive;
		const extra = result.pluginsProvisioned === undefined ? {} : { pluginsProvisioned: result.pluginsProvisioned };
		const error = launchError(res);
		deps.log(`${unit.team} ${success ? "is up" : `did not come up${error ? `: ${error}` : ""}`}`);
		if (!success) {
			const failure = errorFailure(error ?? "the session did not come up");
			deps.send(failedWakeFrame(unit.team, failure, { screen: res.screen, ...extra }));
			return;
		}
		deps.send({
			type: "wake_result",
			team: unit.team,
			success,
			screen: res.screen,
			...(error ? { error } : {}),
			...extra,
		});
	}

	/** Admits a launch, or answers why it will not run. */
	function admit(door: LaunchDoor, team: string, req: LaunchRequest): LaunchUnit | Refusal {
		// Before any container starts.
		const placement = placementRefusal(req.harness, req.target);
		if (placement) return refusal(errorFailure(placement), team, false, placement);
		let target = req.target;
		let projectPath: string | undefined;
		if (target.kind !== "host") {
			const found = deps.project(target.name, req.projectPath);
			if (found.refused !== undefined) {
				deps.log(`${team}: ${found.refused}`);
				return refusal({ kind: "container", spawn: target.name, projectPath: found.path }, team, true);
			}
			projectPath = found.path;
			target = { ...target, name: path.basename(found.path) };
		}
		const pane = physicalPane(target);
		const joined = joinable(pane, door, team);
		if (joined) {
			if (door === "create" && joined.door === "wake") joined.joinedCreate = true;
			return joined;
		}
		// A Stop fences earlier queued launches.
		const generation = target.kind === "host" ? 0 : deps.generation(target.name);
		let resolveDone!: (result: Settled) => void;
		const unit: LaunchUnit = {
			kind: "launch",
			door,
			team,
			target,
			...(target.kind === "host" ? {} : { project: target.name, projectPath }),
			started: false,
			settled: false,
			cancelled: false,
			joinedCreate: false,
			done: new Promise<Settled>((resolve) => {
				resolveDone = resolve;
			}),
			settle(result) {
				if (unit.settled) return;
				unit.settled = true;
				resolveDone(result);
			},
			async run() {
				let result: Settled;
				try {
					result = await body(unit, req, generation);
					if (result.ok && unit.cancelled && result.res.created && !unit.joinedCreate) {
						await deps.kill(unit.target).catch(() => {});
						result = refusal(GAVE_UP, team, false);
					}
				} catch (err) {
					result = settledOf(unit, err);
				}
				unit.settle(result);
			},
		};
		if (door === "wake") unit.done.then((result) => replyWake(unit, result, req.fresh === true));
		enqueue(pane, unit);
		return unit;
	}

	/** Behind whatever runs on the pane. */
	function kill(target: TmuxTarget): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const unit: KillUnit = {
				kind: "kill",
				started: false,
				settled: false,
				async run() {
					try {
						await deps.kill(target);
						resolve();
					} catch (err) {
						reject(err);
					} finally {
						unit.settled = true;
					}
				},
			};
			enqueue(physicalPane(target), unit);
		});
	}

	return {
		/** A wake answers by frames. */
		wake(team: string, req: LaunchRequest): void {
			madePanes.delete(team);
			const admitted = admit("wake", team, req);
			if ("kind" in admitted) return;
			deps.log(`refusing wake of "${team}": ${admitted.text}`);
			deps.send(failedWakeFrame(team, admitted.failure));
		},

		/** A create answers its host op. */
		async create(req: LaunchRequest): Promise<CreateAnswer> {
			const team = composeSessionName(req.target.name, req.target.sessionName);
			madePanes.delete(team);
			const admitted = admit("create", team, req);
			return createAnswer("kind" in admitted ? await admitted.done : admitted, team);
		},

		/** The Gateway gave up on this team's wakes. */
		cancel(team: string): void {
			const units = liveWakes(team);
			for (const unit of units) {
				deps.log(`the Gateway gave up on ${team}`);
				unit.cancelled = true;
				// Never started, and nobody else waits on it.
				if (!unit.started && !unit.joinedCreate) unit.settle(refusal(GAVE_UP, team, false));
			}
			if (units.length > 0) return;
			const made = madePanes.get(team);
			madePanes.delete(team);
			if (!made || deps.now() - made.at >= LATE_CANCEL_MS) return;
			deps.log(`the Gateway gave up on ${team} after it started; closing its pane`);
			kill(made.target).catch((err) =>
				deps.log(`could not close ${team}: ${err instanceof Error ? err.message : err}`),
			);
		},

		kill,

		/** Fails queued and unregistered launches; a running one fails at its fence. */
		stop(project: string): void {
			for (const units of lanes.values()) {
				for (const unit of units) {
					if (unit.kind !== "launch" || unit.started || unit.project !== project) continue;
					unit.settle(refusal({ kind: "stopped" }, unit.team, true));
				}
			}
			const now = deps.now();
			for (const [team, made] of madePanes) {
				if (made.target.kind === "host" || made.target.name !== project) continue;
				madePanes.delete(team);
				if (now - made.at < LATE_CANCEL_MS) deps.send(failedWakeFrame(team, { kind: "stopped" }));
			}
		},

		/** The Gateway forgets stages with the link. */
		replayStages(): void {
			for (const { frame } of stages.values()) deps.send(frame);
		},
	};
}

export type LaunchLane = ReturnType<typeof createLaunchLane>;
