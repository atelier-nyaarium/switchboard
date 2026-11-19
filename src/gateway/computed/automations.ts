// The automation store.

import { z } from "zod";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { reached } from "../../shared/automation-walk.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { chainedTimer } from "../../shared/chained-timer.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import { errorName } from "../../shared/error-name.js";
import {
	AUTOMATION_ACTIONS,
	AUTOMATIONS_MAX,
	type Automation,
	type AutomationAction,
	type AutomationActionParam,
	type AutomationRow,
	AutomationSchema,
	type AutomationTrigger,
	type ConsoleAutomationDeleteResult,
	type ConsoleAutomationPutResult,
	type EventTrigger,
	type TellWhen,
} from "../../shared/schemasAutomation.js";
import { hasHoles, unescapedText, unreadText } from "../../shared/text-holes.js";
import { createOwnerRecords, type OwnerIssue, type OwnerRecord } from "../ownerRecords.js";
import { CLOCK_GRACE_MS, clockShown, isClock, nextSlot, walkSlots } from "./automationClock.js";
import {
	admit,
	claim,
	claimedPaths,
	type Fire,
	type FireNames,
	finished,
	holdsClaim,
	type LandedSet,
	mayRun,
	nextEffect,
	nextFill,
	outdatedSets,
	type Runnable,
	type StepRef,
	stepKey,
	stepsOf,
	switchOf,
	turnOf,
	WAITING_EVENTS_MAX,
	withStep,
} from "./automationFires.js";
import {
	AUTOMATION_KIND,
	type AutomationIntent,
	type DroppedAutomation,
	judgeAutomationWrite,
	NOT_HOME,
} from "./automationJudge.js";
import { type AutomationRun, fireRun, logged } from "./automationLog.js";
import { clip, type Dropped, memberOf, outboxOf, ownerOf, QUEUE_FULL, told } from "./automationOutbox.js";
import {
	type Attempt,
	type AutomationActionPorts,
	type AutomationEffect,
	isEffect,
	natureOf,
	runEffect,
} from "./automationRunner.js";
import { type Checkpoint, FIRED_MAX, own, restore, type State, versionKey } from "./automationState.js";
import {
	begun,
	clamped,
	dueAt,
	endRun,
	heard,
	isEnded,
	type Nature,
	outOfTime,
	recovered,
	refusedUnsent,
	type Step,
	timedOut,
	unsent,
} from "./automationSteps.js";
import { holeSpanOf, holeTexts, laneTellWhen, tellPlan } from "./automationText.js";
import { createAutomationValidity } from "./automationValidity.js";
import { createAutomationWords, fieldsOf, type WatchedReading } from "./automationWords.js";
import type { ComputedFields, DerivedField } from "./computedFields.js";
import { crossingField, crossingFieldId } from "./crossingBand.js";
import { type HeardSensor, silenceNotices } from "./sensorSilence.js";

export { FIRES_MAX, WAITING_EVENTS_MAX } from "./automationFires.js";
export { type AutomationRun, RUN_OUTCOMES } from "./automationLog.js";
export {
	type AutomationOutbox,
	type OutboxEvent,
	QUEUE_MAX_BYTES,
	QUEUE_MAX_EVENTS,
} from "./automationOutbox.js";
export { BACKOFF_MAX_MS, BACKOFF_MIN_MS, KEEP_TRYING_MS } from "./automationSteps.js";
export type { WatchedReading } from "./automationWords.js";
export { AUTOMATION_KIND };

export type AutomationWritten =
	/** `records` holds null for a remove. */
	| { written: true; records: (OwnerRecord<Automation> | null)[]; dropped: readonly DroppedAutomation[] }
	| { written: false; reason: string; record?: OwnerRecord<Automation>; confirm?: string[]; issue?: OwnerIssue };

/** A filled effect parameter. */
const EFFECT_TEXT_MAX = 500;
const NO_RUNNER = "this Gateway runs no such action";
export const NEWER_SET = "a newer setting of this switch landed first";

const actionAt = (body: Automation, path: string): AutomationAction | undefined =>
	reached(body).find((at) => at.path === path)?.action;

const hasEffects = (body: Automation): boolean => reached(body).some(({ action }) => isEffect(action));
/** A walk whose write failed is retried after this. */
const CLOCK_RETRY_MS = 30_000;

// Remove 2026-11-28: a body stored before triggers had kinds.
const LegacyBodySchema = z.strictObject({
	label: z.string(),
	enabled: z.boolean(),
	trigger: z.strictObject({ field: z.string(), becomes: z.union([z.string(), z.boolean()]) }),
	action: z.strictObject({ kind: z.literal("tell_assistant") }),
	coolDownSec: z.number(),
});

const StoredAutomationSchema = z.preprocess((body) => {
	const legacy = LegacyBodySchema.safeParse(body);
	if (!legacy.success) return body;
	const { label, enabled, trigger, coolDownSec } = legacy.data;
	return {
		label,
		enabled,
		trigger: { kind: "value", ...trigger, coolDownSec },
		actions: [{ kind: "tell_assistant", when: "quietly" }],
	};
}, AutomationSchema);

/** Holes in a text, checked and filled. */
export interface AutomationHoles {
	issue: (text: string, names: readonly string[]) => { start: number; end: number; message: string } | null;
	/** Never throws. */
	fill: (text: string, names: Readonly<FireNames>) => Promise<{ text: string; failed: number }>;
}

export interface AutomationsDeps {
	records: DurableStore;
	state: DurableStore;
	fields: ComputedFields;
	newIncarnation: () => string;
	now: () => number;
	isHome: () => boolean;
	/** Wake after queue append. */
	onQueued?: () => void;
	/** Why an event trigger cannot run here. */
	eventIssue?: (trigger: EventTrigger) => string | null;
	/** An event trigger in words. */
	eventSentence?: (trigger: EventTrigger) => string;
	/** Null when no number is read there. */
	reading?: (device: string, measure: string) => WatchedReading | null;
	/** What runs an action's effect. */
	actions?: AutomationActionPorts;
	/** Undefined until the console is composed. */
	holes?: () => AutomationHoles | undefined;
	/** Without it a clock moves only on `tick`. */
	timers?: Pick<Ambient, "setTimer" | "clearTimer">;
	/** Paired sensors; without it no silence is told. */
	sensorsHeard?: () => readonly HeardSensor[];
	/** Names this Gateway in a silence. */
	gatewayName?: string;
}

export function createAutomations(deps: AutomationsDeps) {
	const restored = restore(deps.state.load(), deps.now());
	let state: State = restored.state;
	/** A restore that dropped fires writes once. */
	let unwritten = restored.changed;
	/** Silence counts from here. */
	const startedAt = deps.now();
	const { triggerIssue, holesIssue, automationIssue, armed } = createAutomationValidity(deps);
	const { sentenceOf, watched, namesOf, crossingNames } = createAutomationWords(deps);

	const store = createOwnerRecords<Automation>({
		store: deps.records,
		kinds: { [AUTOMATION_KIND]: StoredAutomationSchema },
		max: AUTOMATIONS_MAX,
		newIncarnation: deps.newIncarnation,
		refusal: (candidate) => holesIssue(candidate.body) ?? automationIssue(candidate.body),
		// Remove 2026-11-28 with the legacy body.
		settle: true,
		label: "automations",
	});
	/** Reads; `write` alone commits. */
	const records: Pick<typeof store, "list" | "get" | "invalidOf" | "count"> = store;

	/** Held fires' versions; unmatched drop. */
	const pinned = (next: State): State["versions"] =>
		Object.fromEntries(
			next.fires.flatMap((fire) => {
				const key = versionKey(fire);
				const record = records.get(fire.automation);
				const current =
					record?.incarnation === fire.incarnation && record.revision === fire.revision
						? record.body
						: undefined;
				const held = own(next.versions, key) ?? current;
				return held ? [[key, held]] : [];
			}),
		);

	/** The one writer of the versions. */
	const commit = (next: State): boolean =>
		commitChecked(
			deps.state,
			{ ...next, versions: pinned(next) },
			(landed) => {
				state = landed;
			},
			{ label: "automation state" },
		).landed;

	{
		const versions = pinned(state);
		if (canonicalJson(versions) !== canonicalJson(state.versions)) unwritten = true;
		state = { ...state, versions };
	}

	/** The body a fire fired with. */
	const bodyOf = (fire: Fire): Automation | null => own(state.versions, versionKey(fire)) ?? null;

	/** The effect at that path, as it fired. */
	const stepAt = (fire: Fire, path: string): AutomationEffect | null => {
		const body = bodyOf(fire);
		const action = body ? actionAt(body, path) : undefined;
		return action && isEffect(action) ? action : null;
	};

	/** Baselines whose write has not landed. */
	let unsaved: State["automations"] = {};

	/** What one pass will commit. */
	interface Work {
		log: AutomationRun[];
		fires: Fire[];
	}

	const workOf = (): Work => ({ log: state.log, fires: [...state.fires] });

	/** `notes`: owner texts, holes unfilled. */
	const withMessage = (
		fields: Record<string, string>,
		messages: readonly string[],
		notes: readonly string[] = [],
	): Record<string, string> => {
		if (messages.length === 0) return fields;
		const told: Record<string, string> = { ...fields, message: clip(messages.join("\n")) };
		if (notes.length > 0) told.note = clip(notes.join("\n"));
		return told;
	};

	/** Records a fire for the run; false when nothing will run. */
	const fire = (
		work: Work,
		record: OwnerRecord<Automation>,
		at: { member: string; seq: number; at: number },
		names: FireNames,
		fields: Record<string, string>,
	): boolean => {
		const plan = tellPlan(record.body);
		const fired = { automation: record.id, seq: at.seq, at: at.at };
		const home = deps.isHome();
		if (plan.when !== null && !home) work.log = logged(work.log, fireRun(fired, "refused", NOT_HOME));
		const told = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, clip(value)]));
		const tell: Fire["tell"] =
			plan.when === null || !home
				? undefined
				: plan.filling
					? { when: plan.when, fields: told, fill: true }
					: { when: plan.when, fields: withMessage(told, plan.messages.map(unescapedText)) };
		const effects = hasEffects(record.body);
		if (!tell && !effects) return false;
		const recorded: Fire = {
			...fired,
			member: at.member,
			incarnation: record.incarnation,
			revision: record.revision,
			names,
			steps: stepsOf(record.body),
			active: [],
			...(tell ? { tell } : {}),
		};
		const event = record.body.trigger.kind === "event";
		const verdict = admit(work.fires, recorded, {
			// Each event carries its own.
			supersede: effects && !event,
			earlier: (member) => state.fires.some((stored) => stored.member === member),
			...(event ? { waitingMax: WAITING_EVENTS_MAX } : {}),
		});
		work.fires = verdict.fires;
		for (const run of verdict.runs) work.log = logged(work.log, fireRun(run.fire, run.outcome, run.reason));
		return verdict.admitted;
	};

	/** Replays transitions idempotently. */
	function drain(): boolean {
		const now = deps.now();
		const work = workOf();
		const checkpoints: State["automations"] = {};
		const baselines: State["automations"] = {};
		for (const record of records.list()) {
			// The lane runs event triggers.
			const trigger = watched(record);
			if (!trigger || !armed(record)) continue;
			const { field, becomes } = trigger;
			const saved = own(state.automations, record.id);
			const held = unsaved[record.id];
			const was = held?.revision === record.revision && saved?.revision !== record.revision ? held : saved;
			if (held && was === held) baselines[record.id] = held;
			const current = deps.fields.stateOf(field);
			if (!current) {
				if (was) checkpoints[record.id] = was;
				continue;
			}
			const carried =
				was?.incarnation === record.incarnation && was.firedAt !== undefined ? { firedAt: was.firedAt } : {};
			if (!was || was.revision !== record.revision || was.incarnation !== record.incarnation) {
				// Record changes reset baseline.
				const baseline = {
					revision: record.revision,
					incarnation: record.incarnation,
					fieldEpoch: current.epoch,
					handledSeq: current.seq,
					...carried,
				};
				checkpoints[record.id] = baseline;
				baselines[record.id] = baseline;
				continue;
			}
			// Epoch changes reset sequence.
			let at: Checkpoint =
				was.fieldEpoch === current.epoch
					? was
					: {
							revision: record.revision,
							incarnation: record.incarnation,
							fieldEpoch: current.epoch,
							handledSeq: 0,
							...carried,
						};
			const pending = current.changes.filter((row) => row.seq > at.handledSeq);
			const oldest = pending[0]?.seq ?? current.seq + 1;
			if (current.seq > at.handledSeq && oldest > at.handledSeq + 1) {
				const missed = oldest - at.handledSeq - 1;
				const gap = { automation: record.id, seq: oldest - 1, at: now };
				work.log = logged(work.log, fireRun(gap, "uncertain", `missed ${missed} changes`));
				at = { ...at, handledSeq: oldest - 1 };
			}
			for (const row of pending) {
				const crossed = row.value === becomes && row.previous !== becomes;
				const handled = { ...at, handledSeq: row.seq };
				const seen = { automation: record.id, seq: row.seq, at: row.at };
				if (!crossed) {
					at = handled;
					continue;
				}
				if (at.firedAt !== undefined && row.at - at.firedAt < trigger.coolDownSec * 1000) {
					work.log = logged(work.log, fireRun(seen, "suppressed", "cooling down"));
					at = handled;
					continue;
				}
				const member = memberOf(record.id, record.incarnation, current.epoch, row.seq);
				const names = namesOf(record, row.value, trigger.label);
				const fields = { field: trigger.label, value: names.value?.shown ?? String(row.value) };
				const fired = fire(work, record, { member, seq: row.seq, at: row.at }, names, fields);
				at = fired ? { ...handled, firedAt: row.at } : handled;
			}
			checkpoints[record.id] = at;
		}
		const next: State = { ...state, automations: checkpoints, log: work.log, fires: work.fires };
		if (canonicalJson(next) === canonicalJson(state)) {
			pump();
			return true;
		}
		const landed = commit(next);
		unsaved = landed ? {} : baselines;
		pump();
		return landed;
	}

	let clock: { handle: () => TimerHandle } | null = null;
	let stopped = false;

	/** Arms the next slot; retries an unlanded walk. */
	const rearm = (now: number, landed = true): void => {
		if (clock) deps.timers?.clearTimer(clock.handle());
		clock = null;
		if (!deps.timers || stopped) return;
		const nexts = records.list().flatMap((record) => {
			const { trigger } = record.body;
			if (!isClock(trigger) || !armed(record)) return [];
			const next = nextSlot(trigger, own(state.slots, record.id)?.at ?? now);
			return next === null ? [] : [next];
		});
		if (nexts.length === 0) return;
		const wait = landed ? Math.max(0, Math.min(...nexts) - now) : CLOCK_RETRY_MS;
		clock = chainedTimer(deps.timers, wait, () => {
			clock = null;
			tick();
		});
	};

	/** Fires due slots; a late one is counted only. */
	function tick(): boolean {
		if (stopped) return true;
		const now = deps.now();
		const work = workOf();
		const slots: State["slots"] = {};
		for (const record of records.list()) {
			const { trigger } = record.body;
			if (!isClock(trigger) || !armed(record)) continue;
			const held = own(state.slots, record.id);
			if (!held || held.revision !== record.revision || held.incarnation !== record.incarnation) {
				// A saved clock starts from now.
				slots[record.id] = { revision: record.revision, incarnation: record.incarnation, at: now };
				continue;
			}
			if (held.at > now + CLOCK_GRACE_MS) {
				// Stepped back: restart from now.
				slots[record.id] = { ...held, at: now, skip: Math.max(held.at, held.skip ?? held.at) };
				continue;
			}
			const walk = walkSlots(trigger, held.at, now, held.skip);
			for (const next of walk.due) {
				const member = memberOf(record.id, record.incarnation, "slot", next);
				const shown = clockShown(trigger, next);
				fire(work, record, { member, seq: 0, at: next }, { time: { value: next, shown } }, { time: shown });
			}
			if (walk.missed > 0) {
				const gap = { automation: record.id, seq: 0, at: now };
				const reason = `missed ${walk.missed} slot${walk.missed === 1 ? "" : "s"}`;
				work.log = logged(work.log, fireRun(gap, "uncertain", reason));
			}
			const { skip, ...kept } = held;
			if (walk.skipped && skip !== undefined) {
				const before = { automation: record.id, seq: 0, at: skip };
				work.log = logged(work.log, fireRun(before, "suppressed", "it ran before the clock stepped back"));
			}
			slots[record.id] = { ...kept, at: walk.at, ...(skip !== undefined && walk.at < skip ? { skip } : {}) };
		}
		const next: State = { ...state, slots, log: work.log, fires: work.fires };
		const landed = canonicalJson(next) === canonicalJson(state) || commit(next);
		pump();
		rearm(now, landed);
		return landed;
	}

	/** The effect in flight. */
	let running: { ref: StepRef; done: Promise<void> } | null = null;
	/** The fill beside it. */
	let filling: Promise<void> | null = null;
	/** Answers kept until written. */
	const spent = new Map<string, { ref: StepRef; runs: AutomationRun[]; attempt: Attempt; reason?: string }>();
	/** Judged each pass until committed. */
	let recovering = true;

	const isRunning = (ref: StepRef): boolean => running !== null && stepKey(running.ref) === stepKey(ref);

	/** A retiring fire never retries, so it has none. */
	const natureAt = (fire: Fire, path: string, retiring: boolean): Nature | null => {
		const effect = retiring ? null : stepAt(fire, path);
		return effect ? natureOf(effect) : null;
	};

	/** An ended step's row. */
	const endedRun = (fire: Fire, path: string, step: Step, reason?: string): AutomationRun => {
		const run = endRun(step.word);
		return fireRun(fire, run.outcome, reason ?? run.reason, stepAt(fire, path)?.kind);
	};

	/** Judges steps a restart found. */
	const recoverFire = (fire: Fire, held: AutomationRun[], now: number, retiring: boolean) => {
		let log = held;
		let landed = fire;
		for (const [path, step] of Object.entries(fire.steps)) {
			const next = recovered(step, natureAt(fire, path, retiring), now);
			landed = withStep(landed, path, next);
			if (!isEnded(step) && isEnded(next)) log = logged(log, endedRun(fire, path, next));
		}
		return { fire: landed, log };
	};

	/** A retiring fire's open steps end with their last word. */
	const endHeard = (fire: Fire, held: AutomationRun[]) => {
		let log = held;
		let landed = fire;
		for (const [path, step] of Object.entries(fire.steps)) {
			// A claim ends when it answers.
			if (isEnded(step) || step.claimed || step.word === undefined) continue;
			const ended = timedOut(step);
			landed = withStep(landed, path, ended);
			log = logged(log, endedRun(fire, path, ended));
		}
		return { fire: landed, log };
	};

	/** Lands answers; a newer set ends older ones. */
	const settle = (stored: readonly Fire[], held: Pick<State, "log" | "ran">, now: number, recover: boolean) => {
		let { log, ran } = held;
		const sets: LandedSet[] = [];
		const settled = stored.map((found) => {
			const retiring = retireOf(found) !== null;
			let fire = found;
			if (recover) ({ fire, log } = recoverFire(fire, log, now, retiring));
			let landedSets: LandedSet[];
			({ fire, log, ran, sets: landedSets } = landAnswers(fire, { log, ran }, now, retiring));
			sets.push(...landedSets);
			if (retiring) ({ fire, log } = endHeard(fire, log));
			return fire;
		});
		const outdated = outdatedSets(settled, sets, stepAt);
		const fires = settled.map((fire) =>
			outdated
				.filter((at) => at.member === fire.member)
				.reduce((held, { path }) => {
					const ended = refusedUnsent(held.steps[path] as Step);
					log = logged(log, endedRun(held, path, ended, NEWER_SET));
					return withStep(held, path, ended);
				}, fire),
		);
		return { fires, log, ran };
	};

	/** Lands the answers to its claimed steps. */
	const landAnswers = (fire: Fire, held: Pick<State, "log" | "ran">, now: number, retiring: boolean) => {
		let { log, ran } = held;
		let landed = fire;
		const sets: LandedSet[] = [];
		for (const path of claimedPaths(fire)) {
			const ref = { member: fire.member, path };
			if (isRunning(ref)) continue;
			const answer = spent.get(stepKey(ref));
			if (!answer) continue;
			const step = fire.steps[path] as Step;
			if ("hold" in answer.attempt) {
				landed = withStep(landed, path, unsent(step, now));
				continue;
			}
			log = answer.runs.reduce(logged, log);
			const next = heard(step, natureAt(fire, path, retiring), answer.attempt.word, now);
			landed = withStep(landed, path, next);
			if (!isEnded(next)) continue;
			log = logged(log, endedRun(fire, path, next, answer.reason));
			if (next.verdict !== "done") continue;
			ran = { ...ran, [fire.automation]: fire.at };
			const switched = switchOf(stepAt(fire, path));
			if (switched) sets.push({ member: fire.member, ...switched, at: fire.at });
		}
		return { fire: landed, log, ran, sets };
	};

	/** Why a fire no longer runs. */
	const retireOf = (fire: Fire): AutomationRun | null => {
		const record = records.get(fire.automation);
		if (!record || record.incarnation !== fire.incarnation)
			return fireRun(fire, "uncertain", "the automation is gone");
		if (!bodyOf(fire) || record.revision !== fire.revision)
			return fireRun(fire, "suppressed", "the automation changed");
		const issue = automationIssue(record.body);
		return issue === null ? null : fireRun(fire, "refused", issue);
	};

	/** To the step whose turn it is. */
	const advance = (
		start: Fire,
		held: Pick<State, "log">,
		at: { now: number; home: boolean; runnable: Runnable[] },
	): { fire: Fire; log: AutomationRun[] } => {
		let { log } = held;
		let fire = start;
		for (let path = turnOf(fire); path !== null; path = turnOf(fire)) {
			const step = begun(clamped(fire.steps[path] as Step, at.now), at.now);
			fire = { ...withStep(fire, path, step), active: [path] };
			if (step.claimed) return { fire, log };
			const effect = stepAt(fire, path);
			let ended: { step: Step; reason?: string };
			if (!effect) ended = { step: refusedUnsent(step) };
			else if (outOfTime(step, at.now)) ended = { step: timedOut(step) };
			else if (AUTOMATION_ACTIONS[effect.kind].home && !at.home) {
				ended = { step: refusedUnsent(step), reason: NOT_HOME };
			} else {
				// A hold waits unclaimed.
				const ready = deps.actions?.ready(effect) ?? true;
				const due = dueAt(step);
				if (ready && due <= at.now) at.runnable.push({ ref: { member: fire.member, path }, dueAt: due });
				return { fire, log };
			}
			fire = withStep(fire, path, ended.step);
			log = logged(log, endedRun(fire, path, ended.step, ended.reason));
		}
		return { fire: { ...fire, active: [] }, log };
	};

	const untold = ({ tell: _tell, waiting: _waiting, ...rest }: Fire): Fire => rest;

	/** `unowned` takes the rest. */
	const droppedRuns = (
		log: AutomationRun[],
		dropped: Dropped,
		now: number,
		unowned: Fire | null,
	): AutomationRun[] => {
		let next = log;
		for (const [owner, count] of dropped) {
			const reason = `dropped ${count} older quiet event${count === 1 ? "" : "s"} for room`;
			const by = owner === null ? unowned : { automation: owner, seq: 0, at: now };
			if (by) next = logged(next, fireRun(by, "suppressed", reason, "tell_assistant"));
		}
		return next;
	};

	/** A notice with no room waits. */
	function watchSensors(): boolean {
		// Home only.
		if (stopped || !deps.sensorsHeard || !deps.isHome()) return true;
		const now = deps.now();
		const gateway = deps.gatewayName ?? "This Gateway";
		const found = silenceNotices(state.silences, deps.sensorsHeard(), now, gateway, startedAt);
		let { queue, log } = state;
		let silences = found.held;
		const dropped: Dropped = new Map();
		for (const notice of found.notices) {
			const room = told(
				queue,
				{ member: notice.member, when: notice.when, fields: notice.fields },
				notice.sentence,
				now,
			);
			if (!room) continue;
			queue = room.queue;
			silences = notice.settle(silences);
			for (const [owner, count] of room.dropped) dropped.set(owner, (dropped.get(owner) ?? 0) + count);
		}
		log = droppedRuns(log, dropped, now, null);
		const next: State = { ...state, queue, log, silences };
		if (canonicalJson(next) === canonicalJson(state)) return true;
		const queued = next.queue.lastAt !== state.queue.lastAt;
		const landed = commit(next);
		if (landed && queued) deps.onQueued?.();
		return landed;
	}

	/** Lands outcomes and queues tells with the next claim. */
	function pump(): void {
		if (stopped) return;
		const now = deps.now();
		const home = deps.isHome();
		let { queue, log, ran } = state;
		let fires: Fire[] = [];
		const runnable: Runnable[] = [];
		let queued = false;
		const dropped: Dropped = new Map();
		/** Takes an unowned drop's row. */
		let droppedBy: Fire | null = null;
		/** Retired, awaiting their claim. */
		const retiring = new Set<string>();
		let settled: Fire[];
		({ fires: settled, log, ran } = settle(state.fires, { log, ran }, now, recovering));
		for (const stored of settled) {
			let fire: Fire = stored;
			const retired = retireOf(fire);
			if (retired) {
				// Retired once its effect lands.
				if (holdsClaim(fire)) {
					fires.push(fire);
					retiring.add(fire.member);
				} else if (!finished(fire)) log = logged(log, retired);
				continue;
			}
			const body = bodyOf(fire) as Automation;
			if (fire.tell && !home) {
				log = logged(log, fireRun(fire, "refused", NOT_HOME, "tell_assistant"));
				fire = untold(fire);
			} else if (fire.tell && !fire.tell.fill) {
				const entry = { member: fire.member, when: fire.tell.when, fields: fire.tell.fields };
				const room = told(queue, entry, sentenceOf(body), now);
				if (!room) {
					if (!fire.waiting) log = logged(log, fireRun(fire, "refused", QUEUE_FULL, "tell_assistant"));
					fire = { ...fire, waiting: true };
				} else {
					queue = room.queue;
					for (const [owner, count] of room.dropped) {
						dropped.set(owner, (dropped.get(owner) ?? 0) + count);
						if (owner === null) droppedBy = fire;
					}
					log = logged(log, fireRun(fire, "ran", undefined, "tell_assistant"));
					ran = { ...ran, [fire.automation]: fire.at };
					queued = true;
					fire = untold(fire);
				}
			}
			fires.push(fire);
		}
		const turns = mayRun(fires);
		fires = fires.flatMap((held) => {
			let fire = held;
			if (turns.has(fire.member) && !retiring.has(fire.member)) {
				({ fire, log } = advance(fire, { log }, { now, home, runnable }));
			}
			return finished(fire) ? [] : [fire];
		});
		log = droppedRuns(log, dropped, now, droppedBy);
		const effect = running ? null : nextEffect(runnable);
		if (effect) fires = claim(fires, effect, now);
		const toFill = filling ? null : nextFill(fires);
		const moved: State = { ...state, queue, log, ran, fires };
		// An unlanded pass is retried whole, its claim with it.
		if ((unwritten || canonicalJson(moved) !== canonicalJson(state)) && !commit(moved)) return;
		recovering = false;
		unwritten = false;
		for (const [key, { ref }] of [...spent]) {
			const claimed = state.fires.some((held) => held.member === ref.member && held.steps[ref.path]?.claimed);
			if (!claimed) spent.delete(key);
		}
		// The claim's runner registers first.
		if (effect) startEffect(effect);
		if (toFill) startFill(toFill);
		if (queued) deps.onQueued?.();
	}

	/** A held fire and the body it fired with. */
	const heldWork = (member: string) => {
		const fire = state.fires.find((held) => held.member === member);
		const body = fire && bodyOf(fire);
		return fire && body ? { fire, body } : null;
	};

	/** `thrown`: whether a throw pumps again. */
	const launch = (work: () => Promise<boolean>, end: () => void, thrown: boolean): Promise<void> =>
		Promise.resolve()
			.then(work)
			.catch((error) => {
				console.error(`[automations] a run failed: ${errorName(error)}`);
				return thrown;
			})
			.then((moved) => {
				end();
				if (moved) pump();
			});

	function startEffect(ref: StepRef): void {
		const held = heldWork(ref.member);
		if (!held) return;
		const done = launch(
			() =>
				runOne(held.fire, held.body, ref).catch((error) => {
					// `runEffect` keeps port throws, so this one came before sending.
					console.error(`[automations] a run failed: ${errorName(error)}`);
					spent.set(stepKey(ref), { ref, runs: [], attempt: { hold: "it could not be started" } });
					return true;
				}),
			() => {
				running = null;
			},
			true,
		);
		running = { ref, done };
	}

	function startFill(member: string): void {
		const held = heldWork(member);
		if (!held) return;
		filling = launch(
			() => fill(held.fire, held.body),
			() => {
				filling = null;
			},
			false,
		);
	}

	const patched = (member: string, patch: Partial<Fire>): Fire[] =>
		state.fires.map((held) => (held.member === member ? { ...held, ...patch } : held));

	/** Fills a text's holes; a failed hole prints a mark and logs once. */
	const fillerOf = (fire: Fire, runs: AutomationRun[]) => {
		const names = fire.names ?? {};
		const holes = deps.holes?.();
		let threw = false;
		return async (text: string, action: string): Promise<string> => {
			if (!hasHoles(text)) return unescapedText(text);
			if (!holes) {
				runs.push(fireRun(fire, "uncertain", "its holes cannot be read yet", action));
				return unreadText(text);
			}
			let read: Awaited<ReturnType<AutomationHoles["fill"]>>;
			try {
				read = await holes.fill(text, names);
			} catch (error) {
				// A thrown fill gives up.
				console.error(`[automations] a fill failed: ${errorName(error)}`);
				if (!threw) runs.push(fireRun(fire, "uncertain", "its holes could not be read", action));
				threw = true;
				return unreadText(text);
			}
			if (read.failed > 0) {
				runs.push(fireRun(fire, "uncertain", `${read.failed} of its holes could not be read`, action));
			}
			return read.text;
		};
	};

	/** One claimed effect; the pump lands its outcome. */
	async function runOne(fire: Fire, body: Automation, ref: StepRef): Promise<boolean> {
		const runs: AutomationRun[] = [];
		const effect = actionAt(body, ref.path);
		if (!effect || !isEffect(effect)) {
			spent.set(stepKey(ref), { ref, runs, attempt: { word: "refused" }, reason: NO_RUNNER });
			return true;
		}
		const row = AUTOMATION_ACTIONS[effect.kind];
		if (row.home && !deps.isHome()) {
			spent.set(stepKey(ref), { ref, runs, attempt: { word: "refused" }, reason: NOT_HOME });
			return true;
		}
		const filled = fillerOf(fire, runs);
		const texts: Record<string, string> = {};
		for (const { param, text } of holeTexts({ actions: [effect] })) {
			const params: readonly AutomationActionParam[] = row.params;
			const max = params.find((held) => held.name === param)?.max ?? EFFECT_TEXT_MAX;
			texts[param] = (await filled(text, effect.kind)).slice(0, max);
		}
		if (!deps.actions) {
			spent.set(stepKey(ref), { ref, runs, attempt: { word: "refused" }, reason: NO_RUNNER });
			return true;
		}
		const attempt = await runEffect({ ...effect, ...texts }, deps.actions);
		spent.set(stepKey(ref), { ref, runs, attempt });
		return true;
	}

	/** A message's holes; false when nothing moved. */
	async function fill(fire: Fire, body: Automation): Promise<boolean> {
		const runs: AutomationRun[] = [];
		const filled = fillerOf(fire, runs);
		const written = tellPlan(body).messages;
		const messages: string[] = [];
		for (const message of written) messages.push(await filled(message, "tell_assistant"));
		const log = runs.reduce(logged, state.log);
		// The pump may have withdrawn it.
		const held = state.fires.find((stored) => stored.member === fire.member)?.tell;
		if (!held?.fill) return runs.length > 0 && commit({ ...state, log });
		const tell = { when: held.when, fields: withMessage(held.fields, messages, written) };
		return commit({ ...state, fires: patched(fire.member, { tell }), log });
	}

	/** Outcomes in one write. */
	const landSpent = (): void => {
		const landed = settle(state.fires, state, deps.now(), false);
		const fires = landed.fires.filter((fire) => !finished(fire));
		const next: State = { ...state, log: landed.log, ran: landed.ran, fires };
		if (canonicalJson(next) !== canonicalJson(state) && commit(next)) spent.clear();
	};

	const outbox = outboxOf(() => state.queue, deps.now);

	/** One band per crossing. */
	const derivedFields = (): DerivedField[] =>
		records.list().flatMap((record) => {
			const { trigger } = record.body;
			if (trigger.kind !== "crossing") return [];
			return [{ id: crossingFieldId(record.id), incarnation: record.incarnation, body: crossingField(trigger) }];
		});

	const rowOf = (record: OwnerRecord<Automation>): AutomationRow => {
		const invalid = records.invalidOf(record.id);
		const slot = own(state.slots, record.id);
		const lastRanAt = own(state.ran, record.id);
		const { trigger } = record.body;
		const current = slot?.revision === record.revision ? slot : undefined;
		const coming = isClock(trigger) && current && armed(record) ? nextSlot(trigger, current.at) : null;
		const nextRunAt =
			coming !== null && coming === current?.skip && isClock(trigger) ? nextSlot(trigger, coming) : coming;
		return {
			id: record.id,
			revision: record.revision,
			automation: record.body,
			sentence: sentenceOf(record.body),
			...(invalid === null ? {} : { invalid }),
			...(lastRanAt === undefined ? {} : { lastRanAt }),
			...(nextRunAt === null ? {} : { nextRunAt }),
		};
	};

	/** A revived id starts unrun. */
	const forgetRan = (ids: readonly string[]): void => {
		if (!ids.some((id) => Object.hasOwn(state.ran, id))) return;
		commit({ ...state, ran: Object.fromEntries(Object.entries(state.ran).filter(([id]) => !ids.includes(id))) });
	};

	const judged = (intent: AutomationIntent, held: readonly OwnerRecord<Automation>[]) =>
		judgeAutomationWrite(intent, {
			held,
			count: records.count(),
			max: AUTOMATIONS_MAX,
			isHome: deps.isHome(),
			issue: automationIssue,
		});

	/** What removed automations left queued. */
	const dropOwned = (ids: readonly string[]): void => {
		if (ids.length === 0) return;
		const gone = new Set(ids);
		const owned = (member: string) => {
			const owner = ownerOf(member);
			return owner !== null && gone.has(owner);
		};
		const events = state.queue.events.filter((event) => !owned(event.member));
		const fires = state.fires.map((held) => (gone.has(held.automation) ? untold(held) : held));
		const next: State = { ...state, queue: { ...state.queue, events }, fires };
		if (canonicalJson(next) !== canonicalJson(state) && !commit(next)) {
			console.warn("[automations] a removed automation's queued events were not dropped");
		}
	};

	/** Every row lands, or none. */
	function write(intent: AutomationIntent): AutomationWritten {
		const held = records.list();
		const verdict = judged(intent, held);
		if (verdict.kind === "refused") {
			return { written: false, reason: verdict.reason, ...(verdict.confirm ? { confirm: verdict.confirm } : {}) };
		}
		for (const { id, reason } of verdict.dropped) {
			console.warn(`[automations] ${intent.kind}: ${id} dropped: ${reason}`);
		}
		const result = store.batch(verdict.writes);
		if (!result.stored) {
			return {
				written: false,
				reason: result.reason,
				...(result.record ? { record: result.record } : {}),
				...(result.issue ? { issue: result.issue } : {}),
			};
		}
		const known = new Set(held.map((record) => record.id));
		forgetRan(verdict.writes.filter((row) => row.op === "remove" || !known.has(row.id)).map((row) => row.id));
		const live = new Set(records.list().map((record) => record.id));
		dropOwned(held.filter((record) => !live.has(record.id)).map((record) => record.id));
		// Bands follow their crossings.
		deps.fields.derivedChanged();
		drain();
		tick();
		return { written: true, records: result.records, dropped: verdict.dropped };
	}

	drain();
	tick();

	return {
		list: () => records.list(),
		rows: (): AutomationRow[] => records.list().map(rowOf),
		write,
		/** Why `write` would refuse it; writes nothing. */
		refusalOf(intent: AutomationIntent): { reason: string; full: boolean } | null {
			const verdict = judged(intent, records.list());
			if (verdict.kind === "refused") return { reason: verdict.reason, full: false };
			const refused = store.refusalOf(verdict.writes);
			return refused ? { reason: refused.reason, full: refused.full === true } : null;
		},
		derivedFields,
		ownerPut(id: string, body: unknown, base: number, confirmed = false): ConsoleAutomationPutResult {
			const result = write({ kind: "owner_put", id, body, base, confirmed });
			const record = result.written ? result.records[0] : (result.record ?? records.get(id));
			if (result.written && record) return { stored: true, revision: record.revision, row: rowOf(record) };
			return {
				stored: false,
				revision: record?.revision ?? 0,
				reason: result.written ? "not saved; try again" : result.reason,
				...(record ? { row: rowOf(record) } : {}),
				...(!result.written && result.confirm ? { confirm: result.confirm } : {}),
				...(!result.written && holeSpanOf(result.issue) ? { hole: holeSpanOf(result.issue) } : {}),
			};
		},
		ownerRemove(id: string, base: number): ConsoleAutomationDeleteResult {
			const result = write({ kind: "owner_remove", id, base });
			return result.written ? { deleted: true } : { deleted: false, reason: result.reason };
		},
		/** Fires each match once per event. */
		fireEvents(matched: readonly { automation: string; key: string; names: FireNames }[], at: number): void {
			const work = workOf();
			const fired = [...state.fired];
			for (const { automation, key, names } of matched) {
				const record = records.get(automation);
				if (!record || !armed(record)) continue;
				const member = memberOf(record.id, record.incarnation, key);
				const runs = hasEffects(record.body) || tellPlan(record.body).when !== null;
				if (!runs || fired.includes(member)) continue;
				fired.push(member);
				fire(work, record, { member, seq: 0, at }, names, fieldsOf(names));
			}
			if (fired.length === state.fired.length) return;
			const lost = fired.length - state.fired.length;
			if (commit({ ...state, fires: work.fires, fired: fired.slice(-FIRED_MAX), log: work.log })) pump();
			else console.warn(`[automations] ${lost} event fires were not recorded and will not run`);
		},
		/** Resolves once no effect or fill is in flight. */
		async settled(): Promise<void> {
			while (running || filling) await Promise.all([running?.done, filling]);
		},
		/** Event automations that woke the assistant. */
		noteEvents(ids: readonly string[], at: number): void {
			if (ids.length === 0) return;
			const live = new Set(records.list().map((record) => record.id));
			const ran = Object.fromEntries(Object.entries(state.ran).filter(([id]) => live.has(id)));
			for (const id of ids) if (live.has(id)) ran[id] = at;
			commit({ ...state, ran });
		},
		/** Read-time validity; never stored. */
		invalidOf: (id: string): string | null => records.invalidOf(id),
		/** Current trigger names; throws what a put would. */
		namesNow(trigger: Exclude<AutomationTrigger, EventTrigger>): FireNames {
			const probe: Automation = {
				enabled: true,
				trigger,
				actions: [{ kind: "tell_assistant", when: "quietly" }],
			};
			const issue = triggerIssue(probe);
			if (issue !== null) throw new Error(issue);
			if (isClock(trigger)) {
				const now = deps.now();
				return { time: { value: now, shown: clockShown(trigger, now) } };
			}
			if (trigger.kind === "crossing") return crossingNames(trigger);
			const label = deps.fields.get(trigger.field)?.body.label ?? trigger.field;
			const held = deps.fields.value(trigger.field);
			return { value: { value: held.known ? held.value : null }, field: { value: label } };
		},
		/** Field commit callback. */
		drain: (): void => {
			drain();
		},
		/** Clocks that a timer missed. */
		tick: (): void => {
			tick();
		},
		/** Sensors gone silent, or heard again. */
		watchSensors: (): void => {
			watchSensors();
		},
		/** Stops clocks and runs; awaits the run in flight. */
		async stop(): Promise<void> {
			stopped = true;
			if (clock) deps.timers?.clearTimer(clock.handle());
			clock = null;
			while (running || filling) await Promise.all([running?.done, filling]);
			landSpent();
		},
		/** Clear events, then drain; a repeat retries. */
		/** False when the write did not land. */
		emptyOutbox(): boolean {
			return state.queue.events.length === 0 || commit({ ...state, queue: { ...state.queue, events: [] } });
		},
		clear(members: readonly string[]): boolean {
			const events = state.queue.events.filter((event) => !members.includes(event.member));
			if (
				events.length !== state.queue.events.length &&
				!commit({ ...state, queue: { ...state.queue, events } })
			) {
				return false;
			}
			return drain();
		},
		sentenceOf: (id: string): string | null => {
			const record = records.list().find((held) => held.id === id);
			return record ? sentenceOf(record.body) : null;
		},
		/** A source's armed event automations. */
		eventsOf(sourceId: string): { id: string; trigger: EventTrigger; when: TellWhen | null }[] {
			return records.list().flatMap((record) => {
				const { trigger } = record.body;
				if (trigger.kind !== "event" || trigger.source !== sourceId || !armed(record)) return [];
				return [{ id: record.id, trigger, when: laneTellWhen(record.body) }];
			});
		},
		runs: (): readonly AutomationRun[] => state.log,
		checkpoint: (id: string) => own(state.automations, id) ?? null,
		queued: () => state.queue,
		outbox,
	};
}

export type Automations = ReturnType<typeof createAutomations>;
