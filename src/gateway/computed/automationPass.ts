// One pass of the pump: the next state, and the work to start.

import { below, byPath, caseSide, type RunFunction, within } from "../../shared/automation-walk.js";
import { AUTOMATION_ACTIONS, type Automation, type AutomationAction } from "../../shared/schemasAutomation.js";
import { FRAME_VARS_MAX, type FunctionStep, RUN_STRANDS_MAX } from "../../shared/schemasFunction.js";
import { keptOf } from "../../shared/task-values.js";
import {
	claim,
	claimedPaths,
	type Fire,
	type Frame,
	finished,
	holdsClaim,
	intentAt,
	type LandedSet,
	mayRun,
	nextEffects,
	outdatedSets,
	pathsOf,
	type Runnable,
	type StepRef,
	siteIn,
	stepKey,
	switchOf,
	type Target,
	withStep,
} from "./automationFires.js";
import {
	type Address,
	addressIn,
	branchesOf,
	type Ended,
	type FailureCode,
	type FrameMemory,
	moved,
	stepAt,
	strandOf,
	taskOf,
} from "./automationFrames.js";
import { NOT_HOME } from "./automationJudge.js";
import { type RunStamp, recorded } from "./automationLastRun.js";
import { type Log, type LogRow, logged, stepRow, tellRow } from "./automationLog.js";
import { type Dropped, QUEUE_FULL, stepMember, told } from "./automationOutbox.js";
import { type Attempt, type AutomationEffect, isEffect, natureOf } from "./automationRunner.js";
import { own, type State } from "./automationState.js";
import {
	begun,
	clamped,
	dueAt,
	endedOutcome,
	expired,
	FRESH_STEP,
	failedAs,
	failureOf,
	heard,
	isEnded,
	type Nature,
	outOfTime,
	recovered,
	refusedUnsent,
	type Step,
	saying,
	steered,
	timedOut,
	unsent,
} from "./automationSteps.js";
import { awaited, nextEnded, tasksIn } from "./automationTasks.js";
import { isTell } from "./automationText.js";

export interface Answer {
	ref: StepRef;
	rows: LogRow[];
	attempt: Attempt;
	reason?: string;
}

/** Lookups and formatting. */
export interface PassPorts {
	retireOf(fire: Fire): LogRow | null;
	stampOf(fire: Fire): RunStamp;
	enter(
		fire: Fire,
		path: string,
		call: RunFunction,
	): { fire: Fire; first: string } | { refused: string; code?: FailureCode };
	/** The steps the frame at `site` runs. */
	frameBody(fire: Fire, site: string): readonly FunctionStep[] | null;
	bodyOf(fire: Fire): Automation | null;
	actionOf(fire: Fire, path: string): AutomationAction | null;
	stepAt(fire: Fire, path: string): AutomationEffect | null;
	kindAt(fire: Fire, path: string): string | undefined;
	/** Its values are still to read. */
	unreadAt(fire: Fire, path: string): boolean;
	/** A tell's written message, when it had holes. */
	noteAt(fire: Fire, path: string): string | null;
	/** The lane told it already. */
	laneTold(fire: Fire, path: string): boolean;
	errorAt(fire: Fire, path: string): boolean;
	windowOf(fire: Fire): number;
	callAt(body: Automation, path: string): RunFunction | null;
	ready(action: AutomationAction): boolean;
	sentenceOf(body: Automation): string;
	withMessage(
		fields: Record<string, string>,
		messages: readonly string[],
		notes?: readonly string[],
	): Record<string, string>;
}

export interface PassInput {
	state: State;
	now: number;
	home: boolean;
	/** Restart recovery. */
	recover: boolean;
	answers: ReadonlyMap<string, Answer>;
	/** In-flight claimed step. */
	inFlight(ref: StepRef): boolean;
	/** Capacity and held devices. */
	busy: { free: number; devices: ReadonlySet<string>; read: boolean };
}

export interface PassResult {
	next: State;
	effects: StepRef[];
	read: StepRef | null;
	queued: boolean;
}

type Tell = Extract<AutomationAction, { kind: "tell_assistant" }>;
const TELL_KIND: Tell["kind"] = "tell_assistant";
const CALL_KIND: RunFunction["kind"] = "run_function";

export const NEWER_SET = "a newer setting of this switch landed first";
/** A step whose kind its body no longer names. */
const UNKNOWN_KIND = "unknown";
export const FRAME_UNREAD = "the function it ran could not be read";
export const CALL_FAILED = "a step in it failed";
export const TOO_MANY_BESIDE = `more than ${RUN_STRANDS_MAX} steps would run at once`;
export const TOO_MANY_KEPT = `more than ${FRAME_VARS_MAX} values would be kept`;
export const SCRIPT_ERRORS = "its script has errors";
/** Fixed text protects values. */
export const STEP_ERRORS = "this step has errors";
const MESSAGE_UNREAD = "its message was not read before the restart";
// skew:fire-tell: goes with the fire's `tell`.
export const untold = ({ tell: _tell, waiting: _waiting, ...rest }: Fire): Fire => rest;

/** `unowned` takes the rest. */
export const droppedRows = (log: Log, dropped: Dropped, now: number, unowned: Fire | null): Log => {
	let next = log;
	for (const [owner, count] of dropped) {
		const reason = `dropped ${count} older quiet event${count === 1 ? "" : "s"} for room`;
		const by = owner === null ? unowned : { automation: owner, seq: 0, at: now };
		if (by) next = logged(next, tellRow(by, "suppressed", reason));
	}
	return next;
};

export function createPass(ports: PassPorts): {
	pass(input: PassInput): PassResult;
	/** Lands answers for readers. */
	settle(
		stored: readonly Fire[],
		held: Pick<State, "log" | "ran" | "landedSets" | "lastRuns" | "order">,
		now: number,
		recover: boolean,
		answers: ReadonlyMap<string, Answer>,
		inFlight: (ref: StepRef) => boolean,
	): { fires: Fire[]; log: Log; ran: State["ran"]; landedSets: State["landedSets"]; lastRuns: State["lastRuns"] };
	endedRow(fire: Fire, path: string, step: Step, reason?: string): LogRow;
	/** A row for the step at `path`, whatever stands it. */
	rowAt(fire: Fire, path: string, outcome: LogRow["outcome"], reason: string): LogRow;
	/** Strand root, if any. */
	rootOf(fire: Fire, path: string): string | null;
} {
	/** A retiring fire never retries, so it has none. */
	const natureAt = (fire: Fire, path: string, retiring: boolean): Nature | null => {
		const effect = retiring ? null : ports.stepAt(fire, path);
		return effect ? natureOf(effect) : null;
	};

	/** The function a step ran in. */
	const functionAt = (fire: Fire, path: string): string | undefined => {
		const site = siteIn(fire, path) ?? path;
		const body = ports.bodyOf(fire);
		return fire.frames?.[site]?.function ?? (body ? ports.callAt(body, site)?.function : undefined);
	};
	const kindAt = (fire: Fire, path: string): string => ports.kindAt(fire, path) ?? UNKNOWN_KIND;
	const placeOf = (fire: Fire, path: string) => ({
		step: path,
		action: kindAt(fire, path),
		function: functionAt(fire, path),
	});

	/** An ended step's row. */
	const endedRow = (fire: Fire, path: string, step: Step, reason?: string): LogRow => {
		const ended = endedOutcome(step.word);
		return stepRow(fire, placeOf(fire, path), ended.outcome, reason ?? ended.reason);
	};

	/** What the row serves. */
	const record = (
		lastRuns: State["lastRuns"],
		fire: Fire,
		running: boolean,
		order: State["order"],
		now: number,
	): State["lastRuns"] => {
		const orderOf = (member: string) => own(order.members, member) ?? 0;
		return recorded(lastRuns, fire, running, { kindAt, functionAt, stampOf: ports.stampOf, orderOf }, now);
	};

	/** Judges steps a restart found. */
	const recoverFire = (fire: Fire, held: Log, now: number, retiring: boolean) => {
		let log = held;
		let landed = fire;
		for (const [path, step] of Object.entries(fire.steps)) {
			const next = recovered(step, natureAt(fire, path, retiring), now, ports.windowOf(fire));
			landed = withStep(landed, path, next);
			if (!isEnded(step) && isEnded(next)) log = logged(log, endedRow(fire, path, next));
		}
		return { fire: landed, log };
	};

	/** A retiring fire's open steps end with their last word. */
	const endHeard = (fire: Fire, held: Log) => {
		let log = held;
		let landed = fire;
		for (const [path, step] of Object.entries(fire.steps)) {
			// A claim ends when it answers.
			if (isEnded(step) || step.claimed || step.word === undefined) continue;
			const ended = timedOut(step);
			landed = withStep(landed, path, ended);
			log = logged(log, endedRow(fire, path, ended));
		}
		return { fire: landed, log };
	};

	const landAnswers = (
		fire: Fire,
		held: Pick<State, "log" | "ran">,
		now: number,
		retiring: boolean,
		answers: ReadonlyMap<string, Answer>,
		inFlight: (ref: StepRef) => boolean,
	) => {
		let { log, ran } = held;
		let landed = fire;
		const sets: LandedSet[] = [];
		for (const path of claimedPaths(fire)) {
			const ref = { member: fire.member, path };
			if (inFlight(ref)) continue;
			const answer = answers.get(stepKey(ref));
			if (!answer) continue;
			const step = fire.steps[path] as Step;
			if ("hold" in answer.attempt) {
				landed = withStep(landed, path, unsent(step, now));
				continue;
			}
			log = answer.rows.reduce(logged, log);
			const next = saying(
				heard(step, natureAt(fire, path, retiring), answer.attempt.word, now, ports.windowOf(fire)),
				answer.reason,
			);
			landed = withStep(landed, path, next);
			if (!isEnded(next)) continue;
			log = logged(log, endedRow(fire, path, next, answer.reason));
			if (next.verdict !== "done") continue;
			ran = { ...ran, [fire.automation]: fire.at };
			const switched = switchOf(ports.stepAt(fire, path));
			if (switched)
				sets.push({ member: fire.member, ...switched, at: intentAt(fire, path, (at) => rootOf(fire, at)) });
		}
		return { fire: landed, log, ran, sets };
	};

	const settle = (
		stored: readonly Fire[],
		held: Pick<State, "log" | "ran" | "landedSets" | "lastRuns" | "order">,
		now: number,
		recover: boolean,
		answers: ReadonlyMap<string, Answer>,
		inFlight: (ref: StepRef) => boolean,
	) => {
		let { log, ran, lastRuns } = held;
		const sets: LandedSet[] = [];
		const settled = stored.map((found) => {
			const retiring = ports.retireOf(found) !== null;
			let fire = found;
			if (recover) ({ fire, log } = recoverFire(fire, log, now, retiring));
			let landedSets: LandedSet[];
			({ fire, log, ran, sets: landedSets } = landAnswers(fire, { log, ran }, now, retiring, answers, inFlight));
			sets.push(...landedSets);
			if (retiring) ({ fire, log } = endHeard(fire, log));
			return fire;
		});
		const outdated = outdatedSets(settled, sets, ports.stepAt, rootOf);
		const fires = settled.map((fire) =>
			outdated
				.filter((at) => at.member === fire.member)
				.reduce((held, { path }) => {
					const ended = saying(refusedUnsent(held.steps[path] as Step), NEWER_SET);
					log = logged(log, endedRow(held, path, ended, NEWER_SET));
					return withStep(held, path, ended);
				}, fire),
		);
		const landedSets = { ...held.landedSets };
		for (const { device, ...set } of sets) {
			const before = own(landedSets, device);
			if (!before || before.at <= set.at) landedSets[device] = set;
		}
		for (const fire of fires) lastRuns = record(lastRuns, fire, !finished(fire), held.order, now);
		return { fires, log, ran, landedSets, lastRuns };
	};

	/** How an ended step moves its frame. */
	const howOf = (kind: FunctionStep["kind"], step: Step): Ended => {
		if (step.verdict !== "done") return { how: kind === "throw" ? "thrown" : "failed", failure: failureOf(step) };
		switch (kind) {
			case "if":
				return { how: "took", side: step.side ?? null };
			case "switch":
				return { how: "took", side: step.case === undefined ? null : caseSide(step.case) };
			case "try":
				return { how: "took", side: "try" };
			case "exit":
				return { how: "exit" };
			case "do":
			case "parallel":
			case "start":
			case "await":
			case "throw":
			case "let":
			case "wait":
			case "note":
			case "unparsed":
			case "call":
				return { how: "done" };
			default:
				return kind satisfies never;
		}
	};

	/** Strand root across calls. */
	const rootOf = (fire: Fire, path: string): string | null => {
		let at = path;
		for (;;) {
			const site = siteIn(fire, at);
			if (site === null) return null;
			const body = ports.frameBody(fire, site);
			const address = body ? addressIn(body, below(at, site)) : null;
			const root = address ? strandOf(address) : null;
			if (root) return within(site, root);
			at = site;
		}
	};

	/** Strand-local failure memory. */
	const memoryOf = (frame: Frame, site: string, address: Address): FrameMemory => {
		const root = strandOf(address);
		const failed = root ? frame.strands?.[within(site, root)] : frame.failed;
		return failed ? { failed } : {};
	};

	const remembered = (frame: Frame, site: string, address: Address, memory: FrameMemory): Frame => {
		if (!memory.failed) return frame;
		const root = strandOf(address);
		if (!root) return { ...frame, failed: memory.failed };
		const { code, message, errors } = memory.failed;
		const failed = {
			code,
			message,
			...(errors ? { errors: errors.map(({ code, message }) => ({ code, message })) } : {}),
		};
		return { ...frame, strands: { ...frame.strands, [within(site, root)]: failed } };
	};

	/** Opens a call's frame, or ends the call refused. */
	const entering = (
		held: Fire,
		rows: Log,
		path: string,
		step: Step,
		call: RunFunction,
	): { fire: Fire; log: Log; first?: string } => {
		const refuse = (reason: string, code?: FailureCode) => {
			const ended = code ? failedAs(step, code, reason) : saying(refusedUnsent(step), reason);
			const fire = withStep(held, path, ended);
			return { fire, log: logged(rows, endedRow(fire, path, ended, reason)) };
		};
		if (held.frames?.[path]) return refuse(FRAME_UNREAD);
		const entered = ports.enter(held, path, call);
		return "refused" in entered
			? refuse(entered.refused, entered.code)
			: { fire: entered.fire, log: rows, first: entered.first };
	};

	/** One cursor per strand. */
	const advance = (
		start: Fire,
		held: Pick<State, "log">,
		at: {
			now: number;
			home: boolean;
			runnable: Runnable[];
			targets: Target[];
			/** Unread steps. */
			unread: StepRef[];
			tell: (fire: Fire, path: string, action: Tell) => "told" | "full" | "away";
		},
	): { fire: Fire; log: Log } => {
		let { log } = held;
		let fire = start;
		const queue: string[] = [...fire.active];
		const waiting: string[] = [];
		const beneath = (owner: string): boolean => [...queue, ...waiting].some((path) => path.startsWith(`${owner}.`));
		const close = (path: string, ended: Step, reason?: string): void => {
			const said = saying(ended, reason);
			fire = withStep(fire, path, said);
			log = logged(log, endedRow(fire, path, said, reason));
		};
		const end = (path: string, ended: Step, reason?: string): void => {
			close(path, ended, reason);
			queue.unshift(path);
		};

		/** False when the frame is full. */
		const keep = (site: string, name: string | undefined, value: Record<string, unknown>): boolean => {
			if (name === undefined) return true;
			const frame = fire.frames?.[site];
			if (!frame) return false;
			const vars = { ...frame.vars, [name]: value as Frame["vars"] extends infer V ? V[keyof V] : never };
			if (Object.keys(vars).length > FRAME_VARS_MAX) return false;
			fire = { ...fire, frames: { ...fire.frames, [site]: { ...frame, vars } } };
			return true;
		};

		const endTask = (path: string): void => {
			const step = fire.steps[path] as Step;
			const site = siteIn(fire, path);
			const frame = site === null ? undefined : fire.frames?.[site];
			const failure = frame?.strands?.[path];
			if (frame && failure) {
				const { [path]: _taken, ...strands } = frame.strands ?? {};
				fire = { ...fire, frames: { ...fire.frames, [site as string]: { ...frame, strands } } };
			}
			const order = { ended: nextEnded(fire.steps) };
			const ended = failure ? failedAs(step, failure.code, failure.message, failure.errors) : steered(step);
			close(path, { ...ended, ...order }, failure?.message);
			for (let index = waiting.length - 1; index >= 0; index--) {
				const held = fire.steps[waiting[index] as string];
				if (held?.awaits !== undefined && tasksIn(held.awaits).includes(path)) {
					queue.unshift(...waiting.splice(index, 1));
				}
			}
		};

		/** First failed unawaited task. */
		const unawaited = (site: string) => {
			const failed = Object.entries(fire.steps)
				.filter(
					([path, step]) =>
						siteIn(fire, path) === site &&
						step.ended !== undefined &&
						step.verdict !== "done" &&
						!step.seen,
				)
				.sort(([, left], [, right]) => (left.ended ?? 0) - (right.ended ?? 0));
			const [first] = failed;
			return first ? failureOf(first[1]) : undefined;
		};

		const endFrame = (site: string): void => {
			const call = fire.steps[site];
			const failure = fire.frames?.[site]?.failed ?? unawaited(site);
			if (!call || isEnded(call)) return;
			if (!failure) fire = withStep(fire, site, heard(call, null, "done", at.now));
			else {
				const ended = failedAs(call, "call_failed", failure.message);
				fire = withStep(fire, site, ended);
				log = logged(log, endedRow(fire, site, ended, CALL_FAILED));
			}
			queue.unshift(site);
		};

		/** Branch outcomes join. */
		const endBlock = (path: string): void => {
			const step = fire.steps[path] as Step;
			const site = siteIn(fire, path);
			const frame = site === null ? undefined : fire.frames?.[site];
			const body = site === null ? null : ports.frameBody(fire, site);
			const address = body && site !== null ? addressIn(body, below(path, site)) : null;
			if (site === null || !frame || !body || !address) {
				end(path, refusedUnsent(step), FRAME_UNREAD);
				return;
			}
			const roots = branchesOf(body, address).map((each) => within(site, each));
			const errors = roots.flatMap((root) => frame.strands?.[root] ?? []);
			const strands = Object.fromEntries(
				Object.entries(frame.strands ?? {}).filter(([root]) => !roots.includes(root)),
			);
			fire = { ...fire, frames: { ...fire.frames, [site]: { ...frame, strands } } };
			if (errors.length === 0) {
				fire = withStep(fire, path, steered(step));
				queue.unshift(path);
				return;
			}
			const reason = `${errors.length} of ${roots.length} failed`;
			end(path, failedAs(step, "together", reason, errors), reason);
		};

		/** Close exhausted owners. */
		const settleOwners = (left: string): void => {
			const parts = left.split(".");
			for (let length = parts.length - 1; length >= 1; length--) {
				const owner = parts.slice(0, length).join(".");
				const step = fire.steps[owner];
				if (!step || isEnded(step)) continue;
				const frame = fire.frames?.[owner] !== undefined;
				const kind = frame ? "call" : ports.kindAt(fire, owner);
				if (kind !== "call" && kind !== "parallel" && kind !== "start") continue;
				if (beneath(owner)) return;
				// Task end moves no cursor.
				if (kind === "start") {
					endTask(owner);
					continue;
				}
				if (frame) endFrame(owner);
				else endBlock(owner);
				return;
			}
		};

		/** Unread frames refuse descendants. */
		const abandon = (site: string): void => {
			for (const [path, step] of Object.entries(fire.steps)) {
				if (path.startsWith(`${site}.`) && !isEnded(step) && !step.claimed) {
					fire = withStep(fire, path, saying(refusedUnsent(step), FRAME_UNREAD));
				}
			}
			for (const list of [queue, waiting]) {
				for (let index = list.length - 1; index >= 0; index--) {
					if ((list[index] as string).startsWith(`${site}.`)) list.splice(index, 1);
				}
			}
			const call = fire.steps[site];
			if (call && !isEnded(call)) end(site, failedAs(call, "refused", FRAME_UNREAD), FRAME_UNREAD);
		};

		const leave = (path: string, step: Step | Ended): void => {
			const site = siteIn(fire, path);
			if (site === null) return;
			const frame = fire.frames?.[site];
			const body = ports.frameBody(fire, site);
			const address = body ? addressIn(body, below(path, site)) : null;
			const written = body && address ? stepAt(body, address) : null;
			if (!frame || !body || !address || !written) {
				abandon(site);
				return;
			}
			const how = "how" in step ? step : howOf(written.kind, step);
			const went = moved(body, address, how, memoryOf(frame, site, address));
			let next = remembered(frame, site, address, went.memory);
			if ("to" in went.move) {
				const { caught } = went.move;
				if (caught) next = { ...next, caught: { ...next.caught, [within(site, caught.by)]: caught.failure } };
				const to = within(site, went.move.to);
				fire = {
					...fire,
					steps: { ...fire.steps, [to]: fire.steps[to] ?? FRESH_STEP },
					frames: { ...fire.frames, [site]: next },
				};
				queue.unshift(to);
				return;
			}
			fire = { ...fire, frames: { ...fire.frames, [site]: next } };
			settleOwners(path);
		};

		const take = (path: string, found: Step): void => {
			const step = begun(clamped(found, at.now), at.now);
			fire = withStep(fire, path, step);
			const acts = switchOf(ports.stepAt(fire, path));
			if (acts) at.targets.push({ member: fire.member, path, device: acts.device });
			if (step.claimed) {
				waiting.push(path);
				return;
			}
			const enter = (call: RunFunction): void => {
				const entered = entering(fire, log, path, step, call);
				({ fire, log } = entered);
				queue.unshift(entered.first ?? path);
			};
			const body = ports.bodyOf(fire);
			const site = siteIn(fire, path);
			const pointer = body && site === null ? ports.callAt(body, path) : null;
			if (pointer) {
				enter(pointer);
				return;
			}
			// Check errors on entry.
			if (found.startedAt === undefined && !ports.laneTold(fire, path) && ports.errorAt(fire, path)) {
				end(path, failedAs(step, "unread", STEP_ERRORS), STEP_ERRORS);
				return;
			}
			const window = ports.windowOf(fire);
			const tree = site === null ? null : ports.frameBody(fire, site);
			const address = tree && site !== null ? addressIn(tree, below(path, site)) : null;
			const kind = tree && address ? stepAt(tree, address)?.kind : undefined;
			const unread = (): void => {
				at.unread.push({ member: fire.member, path });
				waiting.push(path);
			};
			if (kind === "call") {
				// Its values are read first.
				const called = ports.actionOf(fire, path);
				if (called?.kind === CALL_KIND) enter(called);
				else unread();
				return;
			}
			if (kind === "parallel" && tree && address && site !== null) {
				const branches = branchesOf(tree, address).map((each) => within(site, each));
				if (branches.length === 0) {
					fire = withStep(fire, path, steered(step));
					queue.unshift(path);
				} else if (queue.length + waiting.length + branches.length > RUN_STRANDS_MAX) {
					end(path, refusedUnsent(step), TOO_MANY_BESIDE);
				} else {
					const fresh = Object.fromEntries(branches.map((to) => [to, fire.steps[to] ?? FRESH_STEP]));
					// Old builds reject `strands`.
					const frame = fire.frames?.[site] as Frame;
					fire = {
						...fire,
						steps: { ...fire.steps, ...fresh },
						frames: { ...fire.frames, [site]: { ...frame, strands: frame.strands ?? {} } },
					};
					// Wait for every branch.
					queue.unshift(...branches);
				}
				return;
			}
			if (kind === "start" && tree && address && site !== null) {
				const entry = taskOf(tree, address);
				const as = (stepAt(tree, address) as { as?: string } | null)?.as;
				if (entry && queue.length + waiting.length + 2 > RUN_STRANDS_MAX) {
					end(path, refusedUnsent(step), TOO_MANY_BESIDE);
					return;
				}
				if (!keep(site, as, keptOf(path))) {
					end(path, refusedUnsent(step), TOO_MANY_KEPT);
					return;
				}
				if (entry) {
					const to = within(site, entry);
					const frame = fire.frames?.[site] as Frame;
					fire = {
						...fire,
						steps: { ...fire.steps, [to]: fire.steps[to] ?? FRESH_STEP },
						// Old builds reject `strands`.
						frames: { ...fire.frames, [site]: { ...frame, strands: frame.strands ?? {} } },
					};
					queue.unshift(to);
				} else close(path, { ...steered(step), ended: nextEnded(fire.steps) });
				// Ends at once; record stays open.
				leave(path, { how: "done" });
				return;
			}
			if (kind === "await" && site !== null) {
				if (!step.awaits) {
					unread();
					return;
				}
				const outcome = awaited(step.awaits, fire.steps);
				if (!outcome) {
					waiting.push(path);
					return;
				}
				const as = (tree && address ? (stepAt(tree, address) as { as?: string } | null) : null)?.as;
				if (!keep(site, as, outcome.kept)) {
					end(path, refusedUnsent(step), TOO_MANY_KEPT);
					return;
				}
				for (const task of outcome.seen) {
					const held = fire.steps[task];
					if (held) fire = withStep(fire, task, { ...held, seen: true });
				}
				const { failure } = outcome;
				if (!failure) end(path, steered(step));
				else end(path, failedAs(step, failure.code, failure.message, failure.errors), failure.message);
				return;
			}
			if (kind === "unparsed") {
				end(path, failedAs(step, "unread", SCRIPT_ERRORS), SCRIPT_ERRORS);
				return;
			}
			if (kind !== undefined && kind !== "do") {
				if (kind === "try" || kind === "exit" || kind === "note") {
					fire = withStep(fire, path, steered(step));
					queue.unshift(path);
				} else if (kind === "wait" && step.until !== undefined) {
					if (at.now < step.until) waiting.push(path);
					else {
						fire = withStep(fire, path, steered(step));
						queue.unshift(path);
					}
				}
				// A condition, a value, the minutes or a thrown text is read first.
				else unread();
				return;
			}
			if (ports.laneTold(fire, path)) {
				fire = withStep(fire, path, steered(step));
				queue.unshift(path);
				return;
			}
			const action = ports.actionOf(fire, path);
			// Away, a tell is refused before its message is read.
			const away = !at.home && ports.kindAt(fire, path) === TELL_KIND;
			if (!away && !action && ports.unreadAt(fire, path)) {
				unread();
				return;
			}
			if (away) end(path, refusedUnsent(step), NOT_HOME);
			else if (site !== null && !action) end(path, refusedUnsent(step), FRAME_UNREAD);
			else if (action && isTell(action)) {
				// Past its window it is not told, as an effect is not tried.
				const told = outOfTime(step, at.now, window) ? "late" : at.tell(fire, path, action);
				if (told === "told") end(path, heard(step, null, "done", at.now));
				else if (told === "away") end(path, refusedUnsent(step), NOT_HOME);
				else if (told === "late") end(path, expired(step));
				else {
					log = logged(log, stepRow(fire, placeOf(fire, path), "refused", QUEUE_FULL));
					waiting.push(path);
				}
			} else if (!action || !isEffect(action)) end(path, refusedUnsent(step));
			else if (outOfTime(step, at.now, window)) end(path, timedOut(step));
			else if (AUTOMATION_ACTIONS[action.kind].home && !at.home) end(path, refusedUnsent(step), NOT_HOME);
			else {
				// A hold waits unclaimed.
				const due = dueAt(step);
				if (ports.ready(action) && due <= at.now)
					at.runnable.push({ ref: { member: fire.member, path }, dueAt: due });
				waiting.push(path);
			}
		};

		for (;;) {
			if (queue.length === 0) {
				if (waiting.length > 0) break;
				const own = pathsOf(fire).find(
					(path) => siteIn(fire, path) === null && !isEnded(fire.steps[path] as Step),
				);
				if (own === undefined) break;
				queue.push(own);
			}
			const path = queue.shift() as string;
			const step = fire.steps[path];
			if (!step) continue;
			if (isEnded(step)) leave(path, step);
			else take(path, step);
		}
		return { fire: { ...fire, active: waiting.sort(byPath) }, log };
	};

	function runPass(input: PassInput): PassResult {
		let { queue, log, ran } = input.state;
		let fires: Fire[] = [];
		const runnable: Runnable[] = [];
		let queued = false;
		const dropped: Dropped = new Map();
		/** Takes an unowned drop's row. */
		let droppedBy: Fire | null = null;
		/** Retired, awaiting their claim. */
		const retiring = new Set<string>();
		const settledPass = settle(
			input.state.fires,
			{ ...input.state, log, ran },
			input.now,
			input.recover,
			input.answers,
			input.inFlight,
		);
		const { fires: settledFires, landedSets } = settledPass;
		let { lastRuns } = settledPass;
		({ log, ran } = settledPass);
		for (const stored of settledFires) {
			let fire: Fire = stored;
			const retired = ports.retireOf(fire);
			if (retired) {
				// Retired once its effect lands.
				const holds = holdsClaim(fire);
				lastRuns = record(lastRuns, fire, holds, input.state.order, input.now);
				if (holds) {
					fires.push(fire);
					retiring.add(fire.member);
				} else if (!finished(fire)) log = logged(log, retired);
				continue;
			}
			const body = ports.bodyOf(fire) as Automation;
			// skew:fire-tell: the one tell 8.14.87 stored for a whole fire, told as it stands.
			if (fire.tell && !input.home) {
				log = logged(log, tellRow(fire, "refused", NOT_HOME));
				fire = untold(fire);
			} else if (fire.tell) {
				const { when, fields, fill } = fire.tell;
				if (fill) {
					log = logged(log, tellRow(fire, "uncertain", MESSAGE_UNREAD));
					fire = { ...fire, tell: { when, fields } };
				}
				const entry = { member: fire.member, when, fields };
				const room = told(queue, entry, ports.sentenceOf(body), input.now);
				if (!room) {
					if (!fire.waiting) log = logged(log, tellRow(fire, "refused", QUEUE_FULL));
					fire = { ...fire, waiting: true };
				} else {
					queue = room.queue;
					for (const [owner, count] of room.dropped) {
						dropped.set(owner, (dropped.get(owner) ?? 0) + count);
						if (owner === null) droppedBy = fire;
					}
					log = logged(log, tellRow(fire, "ran", undefined));
					ran = { ...ran, [fire.automation]: fire.at };
					queued = true;
					fire = untold(fire);
				}
			}
			fires.push(fire);
		}
		const unread: StepRef[] = [];
		const targets: Target[] = [];
		const tell = (fire: Fire, path: string, action: Tell): "told" | "full" | "away" => {
			const body = ports.bodyOf(fire);
			if (!input.home || !body) return "away";
			const message = action.message === undefined ? [] : [action.message];
			const note = ports.noteAt(fire, path);
			const fields = ports.withMessage(fire.fields ?? {}, message, note === null ? [] : [note]);
			const entry = { member: stepMember(fire.member, path), when: action.when, fields };
			const room = told(queue, entry, ports.sentenceOf(body), input.now);
			if (!room) return "full";
			queue = room.queue;
			for (const [owner, count] of room.dropped) {
				dropped.set(owner, (dropped.get(owner) ?? 0) + count);
				if (owner === null) droppedBy = fire;
			}
			ran = { ...ran, [fire.automation]: fire.at };
			queued = true;
			return "told";
		};
		const advanced = new Set<string>();
		const turnsOf = (held: Fire[]): Fire[] => {
			const turns = mayRun(held);
			return held.flatMap((found) => {
				let fire = found;
				if (turns.has(fire.member) && !retiring.has(fire.member) && !advanced.has(fire.member)) {
					advanced.add(fire.member);
					({ fire, log } = advance(
						fire,
						{ log },
						{ now: input.now, home: input.home, runnable, targets, unread, tell },
					));
				}
				lastRuns = record(lastRuns, fire, !finished(fire), input.state.order, input.now);
				return finished(fire) ? [] : [fire];
			});
		};
		// Ended run passes its turn.
		fires = turnsOf(turnsOf(fires));
		log = droppedRows(log, dropped, input.now, droppedBy);
		const effects = nextEffects(runnable, targets, input.busy);
		for (const effect of effects) fires = claim(fires, effect, input.now);
		const toRead = input.busy.read ? null : (unread[0] ?? null);
		const next: State = { ...input.state, queue, log, ran, fires, landedSets, lastRuns };
		return { next, effects, read: toRead, queued };
	}

	const rowAt = (fire: Fire, path: string, outcome: LogRow["outcome"], reason: string): LogRow =>
		stepRow(fire, placeOf(fire, path), outcome, reason);

	return { pass: runPass, settle, endedRow, rowAt, rootOf };
}
