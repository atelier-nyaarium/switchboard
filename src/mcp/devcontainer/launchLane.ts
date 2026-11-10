import path from "node:path";
import type { TmuxTarget } from "../../shared/host-op.js";
import { type LaunchFailure, launchFailureText } from "../../shared/launch-notice.js";
import { HARNESS, readHarness, type SessionHarness } from "../../shared/session-harness.js";
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
	/** The Gateway's id; absent from an older Gateway. */
	launchId?: string;
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
	uuid(): string;
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

/** One request a unit answers. */
interface Taker {
	door: LaunchDoor;
	team: string;
	launchId?: string;
	fresh: boolean;
	cancelled: boolean;
	answered: boolean;
	/** A create's host op; a wake answers by frame. */
	reply?: (result: Settled) => void;
}

interface LaunchUnit {
	kind: "launch";
	/** The first request's door decides the repair. */
	door: LaunchDoor;
	team: string;
	target: TmuxTarget;
	/** Containers only. */
	project?: string;
	projectPath?: string;
	/** Facts the launch runs. */
	req: LaunchRequest;
	takers: Taker[];
	started: boolean;
	settled: boolean;
	/** A kill took the pane. */
	preempted: boolean;
	stage?: { stage: string; extra: Record<string, unknown> };
	/** Its CLI once resolved, and the id it minted; a result repeats `cli_found`. */
	resolved?: { harness: SessionHarness; sessionId?: string };
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

/** An unacknowledged result is replayed this long. */
export const RESULT_KEEP_MS = 30 * 60_000;

////////////////////////////////
//  Functions & Helpers

/** The pane a target names. Every host-kind spawn point shares one tmux server. */
export function physicalPane(target: TmuxTarget): string {
	return target.kind === "host" ? `host:${target.sessionName}` : `container:${target.name}:${target.sessionName}`;
}

export const errorFailure = (reason: string): LaunchFailure => ({ kind: "error", reason: reason.slice(0, 2048) });

const tag = (launchId: string | undefined) => (launchId ? { launchId } : {});

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

/** Mints an id for an unpicked CLI. */
function mintedId(req: LaunchRequest, harness: SessionHarness, uuid: () => string): string | undefined {
	const policy = HARNESS[harness].sessionId;
	if (readHarness(req.harness).read !== "unpicked" || req.resumeSessionId || !policy.minted) return undefined;
	return policy.mint(uuid);
}

function createAnswer(result: Settled, team: string): CreateAnswer {
	if (!result.ok) throw result.typed ? new WakeFailure(result.failure, team, result.text) : new Error(result.text);
	const { res } = result;
	if (res.error) throw new Error(res.error);
	if (!res.created) return { created: false };
	return { created: true, ready: res.ready, alive: res.alive };
}

/** Joinable only with identical facts. */
function sameFacts(held: LaunchRequest, req: LaunchRequest): boolean {
	return (
		held.sessionToken === req.sessionToken &&
		held.resumeSessionId === req.resumeSessionId &&
		(held.fresh === true) === (req.fresh === true) &&
		held.harness === req.harness
	);
}

/** Untagged create answers only `cli_found`. */
function wantsStage(taker: Taker, stage: string): boolean {
	return taker.door === "wake" || taker.launchId !== undefined || stage === "cli_found";
}

/** One queue per physical pane; each request answers under its own launch id. */
export function createLaunchLane(deps: LaunchLaneDeps) {
	const lanes = new Map<string, Unit[]>();
	/** Unconfirmed wakes that made the pane. */
	const madePanes = new Map<string, { team: string; launchId?: string; target: TmuxTarget; at: number }>();
	/** Tagged results until the Gateway acknowledges them. */
	const outbox = new Map<string, { frame: Record<string, unknown>; at: number }>();
	/** Answered ids; a late wake starts nothing. */
	const answered = new Map<string, number>();

	const madeKey = (team: string, launchId: string | undefined) => launchId ?? `team:${team}`;

	function sendResult(launchId: string | undefined, frame: Record<string, unknown>): void {
		if (launchId) {
			pruneOutbox();
			outbox.set(launchId, { frame, at: deps.now() });
			answered.set(launchId, deps.now());
		}
		deps.send(frame);
	}

	function pruneOutbox(): void {
		const now = deps.now();
		for (const [launchId, kept] of outbox) if (now - kept.at >= RESULT_KEEP_MS) outbox.delete(launchId);
		for (const [launchId, at] of answered) if (now - at >= RESULT_KEEP_MS) answered.delete(launchId);
	}

	function forgetMade(match: (made: { team: string; target: TmuxTarget }) => boolean): void {
		for (const [key, made] of madePanes) if (match(made)) madePanes.delete(key);
	}

	function enqueue(pane: string, unit: Unit): void {
		forgetMade((made) => physicalPane(made.target) === pane);
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

	function* liveUnits(): Generator<LaunchUnit> {
		for (const units of lanes.values()) {
			for (const unit of units) if (unit.kind === "launch" && !unit.settled) yield unit;
		}
	}

	const abandoned = (unit: LaunchUnit) => unit.takers.every((taker) => taker.cancelled);

	function stageFrame(taker: Taker, stage: NonNullable<LaunchUnit["stage"]>): Record<string, unknown> {
		return { type: "wake_stage", team: taker.team, ...tag(taker.launchId), stage: stage.stage, ...stage.extra };
	}

	function tellStage(unit: LaunchUnit, taker: Taker): void {
		if (!unit.stage || taker.answered || taker.cancelled || !wantsStage(taker, unit.stage.stage)) return;
		deps.send(stageFrame(taker, unit.stage));
	}

	function sendStage(unit: LaunchUnit, stage: string, extra: Record<string, unknown> = {}): void {
		unit.stage = { stage, extra };
		for (const taker of unit.takers) tellStage(unit, taker);
	}

	/** A wake's frame; `unit` is absent for a refusal at the door. */
	function replyWake(taker: Taker, result: Settled, unit?: LaunchUnit): void {
		// A lost `cli_found` must not leave the record without its CLI and id.
		const id = { ...tag(taker.launchId), ...unit?.resolved };
		if (!result.ok) {
			deps.log(`failed to wake ${taker.team}: ${result.text}`);
			sendResult(taker.launchId, failedWakeFrame(taker.team, result.failure, id));
			return;
		}
		const { res } = result;
		const target = unit?.target as TmuxTarget;
		if (res.created && taker.fresh) {
			madePanes.set(madeKey(taker.team, taker.launchId), {
				team: taker.team,
				...tag(taker.launchId),
				target,
				at: deps.now(),
			});
		}
		// Zero captures means a dead container launch.
		const success = target.kind === "host" ? res.live : res.alive;
		const extra = {
			...id,
			screen: res.screen,
			...(result.pluginsProvisioned === undefined ? {} : { pluginsProvisioned: result.pluginsProvisioned }),
		};
		const error = launchError(res);
		deps.log(`${taker.team} ${success ? "is up" : `did not come up${error ? `: ${error}` : ""}`}`);
		if (!success) {
			sendResult(
				taker.launchId,
				failedWakeFrame(taker.team, errorFailure(error ?? "the session did not come up"), extra),
			);
			return;
		}
		sendResult(taker.launchId, {
			type: "wake_result",
			team: taker.team,
			success,
			...(error ? { error } : {}),
			...extra,
		});
	}

	function answer(taker: Taker, result: Settled, unit?: LaunchUnit): void {
		if (taker.answered) return;
		taker.answered = true;
		const final = taker.cancelled ? refusal(GAVE_UP, taker.team, false) : result;
		if (taker.reply) taker.reply(final);
		else replyWake(taker, final, unit);
	}

	function settle(unit: LaunchUnit, result: Settled): void {
		if (unit.settled) return;
		unit.settled = true;
		unit.stage = undefined;
		for (const taker of unit.takers) answer(taker, result, unit);
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

	/** The launch itself, as the unit's first door asks it. */
	async function body(unit: LaunchUnit, req: LaunchRequest, generation: number): Promise<Settled> {
		let resumeSessionId = req.resumeSessionId;
		const pick = (installed: readonly SessionHarness[]): SessionHarness => {
			const resolved = resolveLaunchHarness(req.harness, unit.target, installed);
			if ("refused" in resolved) {
				if (!resolved.cli) throw new Failed(errorFailure(resolved.refused), resolved.refused, false);
				throw new Failed({ kind: "cli", refusal: resolved.cli }, resolved.refused, true);
			}
			const minted = mintedId(req, resolved.harness, deps.uuid);
			if (minted) resumeSessionId = minted;
			unit.resolved = { harness: resolved.harness, ...(minted ? { sessionId: minted } : {}) };
			sendStage(unit, "cli_found", unit.resolved);
			if (abandoned(unit)) throw new Failed(GAVE_UP, launchFailureText(GAVE_UP, unit.team), false);
			return resolved.harness;
		};
		const facts = (harness: SessionHarness): LaunchFacts => ({
			harness,
			resumeSessionId,
			fresh: req.fresh,
			sessionToken: req.sessionToken,
			workdir: req.workdir,
			door: unit.door,
		});
		if (unit.target.kind === "host") {
			const harness = pick(await deps.installed(unit.target));
			return { ok: true, res: await deps.launch(unit.target, facts(harness)) };
		}
		sendStage(unit, "building");
		const { pluginsProvisioned, value } = await deps.ensureUp(
			unit.project as string,
			unit.projectPath as string,
			generation,
			async (installed) => {
				sendStage(unit, "container_up");
				return deps.launch(unit.target, facts(pick(installed)));
			},
			async (res) => {
				if (res.created && !unit.preempted) await deps.kill(unit.target);
			},
		);
		return { ok: true, res: value, pluginsProvisioned };
	}

	function liveTaker(launchId: string): { unit: LaunchUnit; taker: Taker } | undefined {
		for (const unit of liveUnits()) {
			const taker = unit.takers.find((each) => each.launchId === launchId && !each.answered);
			if (taker) return { unit, taker };
		}
		return undefined;
	}

	function joinable(pane: string, taker: Taker, req: LaunchRequest): LaunchUnit | undefined {
		const tail = lanes.get(pane)?.at(-1);
		if (tail?.kind !== "launch" || tail.settled || tail.team !== taker.team) return undefined;
		if (tail.takers.some((held) => held.cancelled) || !sameFacts(tail.req, req)) return undefined;
		return tail.door === taker.door || (taker.door === "create" && tail.door === "wake") ? tail : undefined;
	}

	function join(unit: LaunchUnit, taker: Taker): void {
		unit.takers.push(taker);
		tellStage(unit, taker);
	}

	/** Joins, queues, or refuses a request. */
	function admit(taker: Taker, req: LaunchRequest): void {
		if (taker.launchId) {
			const held = liveTaker(taker.launchId);
			// A repeated frame; a repeated create still wants its own answer.
			if (held) {
				if (taker.reply) join(held.unit, taker);
				return;
			}
			const kept = outbox.get(taker.launchId);
			if (kept && !taker.reply) {
				deps.send(kept.frame);
				return;
			}
			if (answered.has(taker.launchId) && !taker.reply) {
				deps.log(`dropping a wake for ${taker.launchId}, already answered`);
				return;
			}
		}
		// Before any container starts.
		const placement = placementRefusal(req.harness, req.target);
		if (placement) {
			answer(taker, refusal(errorFailure(placement), taker.team, false, placement));
			return;
		}
		let target = req.target;
		let projectPath: string | undefined;
		if (target.kind !== "host") {
			const found = deps.project(target.name, req.projectPath);
			if (found.refused !== undefined) {
				deps.log(`${taker.team}: ${found.refused}`);
				answer(
					taker,
					refusal({ kind: "container", spawn: target.name, projectPath: found.path }, taker.team, true),
				);
				return;
			}
			projectPath = found.path;
			target = { ...target, name: path.basename(found.path) };
		}
		forgetMade((made) => made.team === taker.team);
		const pane = physicalPane(target);
		const tail = joinable(pane, taker, req);
		if (tail) {
			// An older Gateway's repeated wake is the same request.
			const repeat = !taker.launchId && !taker.reply && tail.takers.some((held) => !held.launchId && !held.reply);
			if (!repeat) join(tail, taker);
			return;
		}
		// Taken now, so a Stop fences what queued before it.
		const generation = target.kind === "host" ? 0 : deps.generation(target.name);
		const unit: LaunchUnit = {
			kind: "launch",
			door: taker.door,
			team: taker.team,
			target,
			...(target.kind === "host" ? {} : { project: target.name, projectPath }),
			req,
			takers: [taker],
			started: false,
			settled: false,
			preempted: false,
			async run() {
				let result: Settled;
				try {
					result = await body(unit, req, generation);
					if (result.ok && result.res.created && abandoned(unit) && !unit.preempted) {
						await deps.kill(unit.target).catch(() => {});
						result = refusal(GAVE_UP, unit.team, false);
					}
				} catch (err) {
					result = settledOf(unit, err);
				}
				settle(unit, result);
			},
		};
		enqueue(pane, unit);
	}

	function giveUp(unit: LaunchUnit, taker: Taker): void {
		taker.cancelled = true;
		answer(taker, refusal(GAVE_UP, taker.team, false), unit);
	}

	/** Ahead of launches, which are given up. */
	function kill(target: TmuxTarget): Promise<void> {
		const pane = physicalPane(target);
		let preempts = false;
		for (const unit of lanes.get(pane) ?? []) {
			if (unit.kind !== "launch" || unit.settled) continue;
			for (const taker of unit.takers) if (!taker.answered) giveUp(unit, taker);
			if (unit.started) {
				unit.preempted = true;
				preempts = true;
			} else {
				unit.settled = true;
			}
		}
		if (preempts) {
			deps.log(`closing ${pane} ahead of its launch`);
			forgetMade((made) => physicalPane(made.target) === pane);
			return deps.kill(target);
		}
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

	/** Answers by frames. */
	const wakeTaker = (
		team: string,
		launchId: string | undefined,
		fresh: boolean,
		door: LaunchDoor = "wake",
	): Taker => ({
		door,
		team,
		...tag(launchId),
		fresh,
		cancelled: false,
		answered: false,
	});

	return {
		/** Wake frame; door marks create. */
		wake(team: string, req: LaunchRequest, door: LaunchDoor = "wake"): void {
			admit(wakeTaker(team, req.launchId, req.fresh === true, door), req);
		},

		/** A wake this machine refuses before the lane. */
		refuse(team: string, launchId: string | undefined, reason: string): void {
			answer(wakeTaker(team, launchId, false), refusal(errorFailure(reason), team, false, reason));
		},

		/** A create answers its host op. */
		async create(req: LaunchRequest): Promise<CreateAnswer> {
			const team = composeSessionName(req.target.name, req.target.sessionName);
			const result = await new Promise<Settled>((reply) => {
				admit(
					{
						door: "create",
						team,
						...tag(req.launchId),
						fresh: false,
						cancelled: false,
						answered: false,
						reply,
					},
					req,
				);
			});
			return createAnswer(result, team);
		},

		/** The Gateway gave up: the request with this id, or a team's untagged ones. */
		cancel(team: string, launchId?: string): void {
			let hit = false;
			for (const unit of liveUnits()) {
				for (const taker of unit.takers) {
					if (taker.team !== team || taker.launchId !== launchId || taker.answered) continue;
					// An older Gateway cancels wakes alone.
					if (!launchId && taker.reply) continue;
					hit = true;
					deps.log(`the Gateway gave up on ${team}${launchId ? ` (${launchId})` : ""}`);
					giveUp(unit, taker);
				}
				// Nobody waits on it.
				if (!unit.started && abandoned(unit)) unit.settled = true;
			}
			if (hit) return;
			const key = madeKey(team, launchId);
			const made = madePanes.get(key);
			madePanes.delete(key);
			if (!made || deps.now() - made.at >= LATE_CANCEL_MS) return;
			const pane = physicalPane(made.target);
			// Another request launched on this pane holds it.
			if ([...madePanes.values()].some((other) => physicalPane(other.target) === pane)) return;
			deps.log(`the Gateway gave up on ${team} after it started; closing its pane`);
			kill(made.target).catch((err) =>
				deps.log(`could not close ${team}: ${err instanceof Error ? err.message : err}`),
			);
		},

		kill,

		/** Fails the project's queued and unregistered launches. */
		stop(project: string): void {
			for (const unit of liveUnits()) {
				if (!unit.started && unit.project === project)
					settle(unit, refusal({ kind: "stopped" }, unit.team, true));
			}
			const now = deps.now();
			for (const [key, made] of madePanes) {
				if (made.target.kind === "host" || made.target.name !== project) continue;
				madePanes.delete(key);
				if (now - made.at >= LATE_CANCEL_MS) continue;
				const failure: LaunchFailure = { kind: "stopped" };
				sendResult(made.launchId, failedWakeFrame(made.team, failure, tag(made.launchId)));
			}
		},

		/** The Gateway forgets stages with the link. */
		replayStages(): void {
			for (const unit of liveUnits()) for (const taker of unit.takers) tellStage(unit, taker);
		},

		/** Every tagged result not yet acknowledged. */
		replayResults(): void {
			pruneOutbox();
			for (const { frame } of outbox.values()) deps.send(frame);
		},

		ack(launchId: string): void {
			outbox.delete(launchId);
		},
	};
}

export type LaunchLane = ReturnType<typeof createLaunchLane>;
