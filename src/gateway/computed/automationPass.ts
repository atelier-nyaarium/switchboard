// One pass of the pump: the next state, and the work to start.

import { below, type RunFunction, type WalkStep, within } from "../../shared/automation-walk.js";
import { AUTOMATION_ACTIONS, type Automation, type AutomationAction } from "../../shared/schemasAutomation.js";
import { hasHoles } from "../../shared/text-holes.js";
import {
	claim,
	claimedPaths,
	type Fire,
	finished,
	holdsClaim,
	intentAt,
	type LandedSet,
	mayRun,
	nextEffect,
	nextFill,
	outdatedSets,
	pathsOf,
	type Runnable,
	type StepRef,
	siteIn,
	stepKey,
	switchOf,
	withStep,
} from "./automationFires.js";
import { addressIn, type Ended, type Failure, moved, stepAt, type TreeStep } from "./automationFrames.js";
import { NOT_HOME } from "./automationJudge.js";
import { fireRow, logged, type RowWhere, type RunRow } from "./automationLog.js";
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
	steered,
	timedOut,
	unsent,
} from "./automationSteps.js";
import { isTell } from "./automationText.js";

export interface Answer {
	ref: StepRef;
	rows: RunRow[];
	attempt: Attempt;
	reason?: string;
}

/** Lookups and formatting. */
export interface PassPorts {
	retireOf(fire: Fire): RunRow | null;
	enter(fire: Fire, path: string, call: RunFunction): Fire | { refused: string };
	/** The steps the frame at `site` runs. */
	frameBody(fire: Fire, site: string): readonly TreeStep[] | null;
	bodyOf(fire: Fire): Automation | null;
	actionOf(fire: Fire, path: string): AutomationAction | null;
	stepAt(fire: Fire, path: string): AutomationEffect | null;
	kindAt(fire: Fire, path: string): string | undefined;
	writtenStep(fire: Fire, path: string): WalkStep<"do"> | null;
	windowOf(fire: Fire, path: string): number;
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
	busy: { effect: boolean; fill: boolean; read: boolean };
}

export interface PassResult {
	next: State;
	effect: StepRef | null;
	fill: string | null;
	read: StepRef | null;
	queued: boolean;
}

type Tell = Extract<AutomationAction, { kind: "tell_assistant" }>;

export const NEWER_SET = "a newer setting of this switch landed first";
export const FRAME_UNREAD = "the function it ran could not be read";
export const CALL_FAILED = "a step in it failed";
export const untold = ({ tell: _tell, waiting: _waiting, ...rest }: Fire): Fire => rest;

/** `unowned` takes the rest. */
export const droppedRows = (log: RunRow[], dropped: Dropped, now: number, unowned: Fire | null): RunRow[] => {
	let next = log;
	for (const [owner, count] of dropped) {
		const reason = `dropped ${count} older quiet event${count === 1 ? "" : "s"} for room`;
		const by = owner === null ? unowned : { automation: owner, seq: 0, at: now };
		if (by) next = logged(next, fireRow(by, "suppressed", reason, "tell_assistant"));
	}
	return next;
};

export function createPass(ports: PassPorts): {
	pass(input: PassInput): PassResult;
	/** Lands answers for readers. */
	settle(
		stored: readonly Fire[],
		held: Pick<State, "log" | "ran" | "landedSets">,
		now: number,
		recover: boolean,
		answers: ReadonlyMap<string, Answer>,
		inFlight: (ref: StepRef) => boolean,
	): { fires: Fire[]; log: RunRow[]; ran: State["ran"]; landedSets: State["landedSets"] };
	endedRow(fire: Fire, path: string, step: Step, reason?: string): RunRow;
	whereAt(fire: Fire, path: string): RowWhere;
} {
	/** A retiring fire never retries, so it has none. */
	const natureAt = (fire: Fire, path: string, retiring: boolean): Nature | null => {
		const effect = retiring ? null : ports.stepAt(fire, path);
		return effect ? natureOf(effect) : null;
	};

	/** A call names its function. */
	const whereAt = (fire: Fire, path: string): RowWhere => {
		const site = siteIn(fire, path) ?? path;
		const body = ports.bodyOf(fire);
		return {
			step: path,
			function: fire.frames?.[site]?.function ?? (body ? ports.callAt(body, site)?.function : undefined),
		};
	};

	/** An ended step's row. */
	const endedRow = (fire: Fire, path: string, step: Step, reason?: string): RunRow => {
		const ended = endedOutcome(step.word);
		return fireRow(fire, ended.outcome, reason ?? ended.reason, ports.kindAt(fire, path), whereAt(fire, path));
	};

	/** Judges steps a restart found. */
	const recoverFire = (fire: Fire, held: RunRow[], now: number, retiring: boolean) => {
		let log = held;
		let landed = fire;
		for (const [path, step] of Object.entries(fire.steps)) {
			const next = recovered(step, natureAt(fire, path, retiring), now, ports.windowOf(fire, path));
			landed = withStep(landed, path, next);
			if (!isEnded(step) && isEnded(next)) log = logged(log, endedRow(fire, path, next));
		}
		return { fire: landed, log };
	};

	/** A retiring fire's open steps end with their last word. */
	const endHeard = (fire: Fire, held: RunRow[]) => {
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
			const next = heard(
				step,
				natureAt(fire, path, retiring),
				answer.attempt.word,
				now,
				ports.windowOf(fire, path),
			);
			landed = withStep(landed, path, next);
			if (!isEnded(next)) continue;
			log = logged(log, endedRow(fire, path, next, answer.reason));
			if (next.verdict !== "done") continue;
			ran = { ...ran, [fire.automation]: fire.at };
			const switched = switchOf(ports.stepAt(fire, path));
			if (switched) sets.push({ member: fire.member, ...switched, at: intentAt(fire) });
		}
		return { fire: landed, log, ran, sets };
	};

	const settle = (
		stored: readonly Fire[],
		held: Pick<State, "log" | "ran" | "landedSets">,
		now: number,
		recover: boolean,
		answers: ReadonlyMap<string, Answer>,
		inFlight: (ref: StepRef) => boolean,
	) => {
		let { log, ran } = held;
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
		const outdated = outdatedSets(settled, sets, ports.stepAt);
		const fires = settled.map((fire) =>
			outdated
				.filter((at) => at.member === fire.member)
				.reduce((held, { path }) => {
					const ended = refusedUnsent(held.steps[path] as Step);
					log = logged(log, endedRow(held, path, ended, NEWER_SET));
					return withStep(held, path, ended);
				}, fire),
		);
		const landedSets = { ...held.landedSets };
		for (const { device, ...set } of sets) {
			const before = own(landedSets, device);
			if (!before || before.at <= set.at) landedSets[device] = set;
		}
		return { fires, log, ran, landedSets };
	};

	/** How an ended step moves its frame. */
	const howOf = (kind: string, step: Step): Ended => {
		if (step.verdict !== "done") return { how: kind === "throw" ? "thrown" : "failed", failure: failureOf(step) };
		if (kind === "if") return { how: "took", side: step.side ?? null };
		if (kind === "try") return { how: "took", side: "try" };
		if (kind === "exit") return { how: "exit" };
		return { how: "done" };
	};

	/** Moves past an ended step. In a frame the active step leads; the automation's own list is scanned. */
	const turn = (start: Fire, held: RunRow[], now: number): { fire: Fire; log: RunRow[]; path: string | null } => {
		let fire = start;
		let log = held;
		for (;;) {
			const active = fire.active[0];
			const step = active === undefined ? undefined : fire.steps[active];
			if (active !== undefined && step && !isEnded(step)) return { fire, log, path: active };
			const site = active === undefined ? null : siteIn(fire, active);
			const frame = site === null ? undefined : fire.frames?.[site];
			if (active === undefined || !step || site === null || !frame) {
				const own = pathsOf(fire).find(
					(path) => siteIn(fire, path) === null && !isEnded(fire.steps[path] as Step),
				);
				if (own === undefined) return { fire, log, path: null };
				fire = { ...fire, active: [own] };
				continue;
			}
			const body = ports.frameBody(fire, site);
			const address = body ? addressIn(body, below(active, site)) : null;
			const written = body && address ? stepAt(body, address) : null;
			const went =
				body && address && written
					? moved(body, address, howOf(written.kind, step), { failed: frame.failed })
					: null;
			const moving = went && "to" in went.move ? went.move : null;
			const caught = moving?.caught
				? { caught: { ...frame.caught, [within(site, moving.caught.by)]: moving.caught.failure } }
				: {};
			const frames = went ? { ...fire.frames, [site]: { ...frame, ...went.memory, ...caught } } : fire.frames;
			if (moving) {
				const to = within(site, moving.to);
				fire = { ...fire, steps: { ...fire.steps, [to]: fire.steps[to] ?? FRESH_STEP }, active: [to], frames };
				continue;
			}
			// The frame ended, and its call with it.
			const failure: Failure | null =
				went === null
					? { code: "refused", message: FRAME_UNREAD }
					: "failure" in went.move
						? went.move.failure
						: null;
			const call = fire.steps[site];
			if (!call || isEnded(call)) {
				fire = { ...fire, frames, active: [] };
				continue;
			}
			const ended =
				failure === null
					? heard(call, null, "done", now)
					: failedAs(call, went === null ? "refused" : "call_failed", failure.message);
			fire = { ...withStep(fire, site, ended), frames, active: [site] };
			if (failure !== null)
				log = logged(log, endedRow(fire, site, ended, went === null ? FRAME_UNREAD : CALL_FAILED));
		}
	};

	/** To the step whose turn it is. */
	const advance = (
		start: Fire,
		held: Pick<State, "log">,
		at: {
			now: number;
			home: boolean;
			runnable: Runnable[];
			/** Unread steps. */
			unread: StepRef[];
			tell: (fire: Fire, path: string, action: Tell) => "told" | "full" | "away";
		},
	): { fire: Fire; log: RunRow[] } => {
		let { log } = held;
		let fire = start;
		for (;;) {
			const next = turn(fire, log, at.now);
			({ fire, log } = next);
			const path = next.path;
			if (path === null) break;
			const step = begun(clamped(fire.steps[path] as Step, at.now), at.now);
			fire = withStep(fire, path, step);
			if (step.claimed) return { fire, log };
			const body = ports.bodyOf(fire);
			const call = body && siteIn(fire, path) === null ? ports.callAt(body, path) : null;
			if (call && fire.frames?.[path]) {
				// Its frame is open with no step active.
				const ended = refusedUnsent(step);
				fire = withStep(fire, path, ended);
				log = logged(log, endedRow(fire, path, ended, FRAME_UNREAD));
				continue;
			}
			if (call) {
				const entered = ports.enter(fire, path, call);
				if (!("refused" in entered)) {
					fire = entered;
					continue;
				}
				const ended = refusedUnsent(step);
				fire = withStep(fire, path, ended);
				log = logged(log, endedRow(fire, path, ended, entered.refused));
				continue;
			}
			const window = ports.windowOf(fire, path);
			const site = siteIn(fire, path);
			const tree = site === null ? null : ports.frameBody(fire, site);
			const address = tree && site !== null ? addressIn(tree, below(path, site)) : null;
			const kind = tree && address ? stepAt(tree, address)?.kind : undefined;
			if (kind !== undefined && kind !== "do") {
				if (kind === "try" || kind === "exit" || kind === "note") {
					fire = withStep(fire, path, steered(step));
					continue;
				}
				if (kind === "wait" && step.until !== undefined) {
					if (at.now < step.until) return { fire, log };
					fire = withStep(fire, path, steered(step));
					continue;
				}
				// A condition, a value, the minutes or a thrown text is read first.
				at.unread.push({ member: fire.member, path });
				return { fire, log };
			}
			const action = ports.actionOf(fire, path);
			if (site !== null && !action && ports.writtenStep(fire, path)) {
				at.unread.push({ member: fire.member, path });
				return { fire, log };
			}
			let ended: { step: Step; reason?: string };
			if (site !== null && !action) ended = { step: refusedUnsent(step), reason: FRAME_UNREAD };
			else if (action && isTell(action)) {
				const told = at.tell(fire, path, action);
				if (told === "told") ended = { step: heard(step, null, "done", at.now) };
				else if (told === "away") ended = { step: refusedUnsent(step), reason: NOT_HOME };
				else if (outOfTime(step, at.now, window)) ended = { step: expired(step) };
				else {
					log = logged(log, fireRow(fire, "refused", QUEUE_FULL, "tell_assistant", whereAt(fire, path)));
					return { fire, log };
				}
			} else if (!action || !isEffect(action)) ended = { step: refusedUnsent(step) };
			else if (outOfTime(step, at.now, window)) ended = { step: timedOut(step) };
			else if (AUTOMATION_ACTIONS[action.kind].home && !at.home) {
				ended = { step: refusedUnsent(step), reason: NOT_HOME };
			} else {
				// A hold waits unclaimed.
				const ready = ports.ready(action);
				const due = dueAt(step);
				if (ready && due <= at.now) at.runnable.push({ ref: { member: fire.member, path }, dueAt: due });
				return { fire, log };
			}
			fire = withStep(fire, path, ended.step);
			log = logged(log, endedRow(fire, path, ended.step, ended.reason));
		}
		return { fire: { ...fire, active: [] }, log };
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
		({ log, ran } = settledPass);
		for (const stored of settledFires) {
			let fire: Fire = stored;
			const retired = ports.retireOf(fire);
			if (retired) {
				// Retired once its effect lands.
				if (holdsClaim(fire)) {
					fires.push(fire);
					retiring.add(fire.member);
				} else if (!finished(fire)) log = logged(log, retired);
				continue;
			}
			const body = ports.bodyOf(fire) as Automation;
			if (fire.tell && !input.home) {
				log = logged(log, fireRow(fire, "refused", NOT_HOME, "tell_assistant"));
				fire = untold(fire);
			} else if (fire.tell && !fire.tell.fill) {
				const entry = { member: fire.member, when: fire.tell.when, fields: fire.tell.fields };
				const room = told(queue, entry, ports.sentenceOf(body), input.now);
				if (!room) {
					if (!fire.waiting) log = logged(log, fireRow(fire, "refused", QUEUE_FULL, "tell_assistant"));
					fire = { ...fire, waiting: true };
				} else {
					queue = room.queue;
					for (const [owner, count] of room.dropped) {
						dropped.set(owner, (dropped.get(owner) ?? 0) + count);
						if (owner === null) droppedBy = fire;
					}
					log = logged(log, fireRow(fire, "ran", undefined, "tell_assistant"));
					ran = { ...ran, [fire.automation]: fire.at };
					queued = true;
					fire = untold(fire);
				}
			}
			fires.push(fire);
		}
		const unread: StepRef[] = [];
		const tell = (fire: Fire, path: string, action: Tell): "told" | "full" | "away" => {
			const body = ports.bodyOf(fire);
			if (!input.home || !body) return "away";
			const message = action.message === undefined ? [] : [action.message];
			const written = ports.writtenStep(fire, path)?.step.args.message;
			const note = written?.kind === "literal" && typeof written.value === "string" ? written.value : null;
			const fields = ports.withMessage(fire.fields ?? {}, message, note !== null && hasHoles(note) ? [note] : []);
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
						{ now: input.now, home: input.home, runnable, unread, tell },
					));
				}
				return finished(fire) ? [] : [fire];
			});
		};
		// Ended run passes its turn.
		fires = turnsOf(turnsOf(fires));
		log = droppedRows(log, dropped, input.now, droppedBy);
		const effect = input.busy.effect ? null : nextEffect(runnable);
		if (effect) fires = claim(fires, effect, input.now);
		const toFill = input.busy.fill ? null : nextFill(fires);
		const toRead = input.busy.read ? null : (unread[0] ?? null);
		const next: State = { ...input.state, queue, log, ran, fires, landedSets };
		return { next, effect, fill: toFill, read: toRead, queued };
	}

	return { pass: runPass, settle, endedRow, whereAt };
}
