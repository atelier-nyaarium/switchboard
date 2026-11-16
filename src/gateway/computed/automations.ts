// Queue and checkpoint, atomically.

import { z } from "zod";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { chainedTimer } from "../../shared/chained-timer.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import {
	AUTOMATION_ACTIONS,
	AUTOMATION_TRIGGER_NAMES,
	AUTOMATIONS_MAX,
	type Automation,
	type AutomationActionParam,
	type AutomationRow,
	AutomationSchema,
	type AutomationTrigger,
	type ConsoleAutomationDeleteResult,
	type ConsoleAutomationPutResult,
	type CrossingTrigger,
	type EventTrigger,
	type TellWhen,
} from "../../shared/schemasAutomation.js";
import { hasHoles, unescapedText, unreadText } from "../../shared/text-holes.js";
import { createOwnerRecords, type OwnerIssue, type OwnerRecord } from "../ownerRecords.js";
import {
	CLOCK_GRACE_MS,
	clockIssue,
	clockSentence,
	clockShown,
	isClock,
	nextSlot,
	walkSlots,
} from "./automationClock.js";
import {
	admit,
	claim,
	EFFECT_LATE_MS,
	EFFECT_RETRY_MS,
	type EffectRef,
	effectKey,
	effectsIn,
	FIRES_MAX,
	type Fire,
	type FireNames,
	FireSchema,
	finished,
	holdsClaim,
	mayWait,
	nextEffect,
	nextFill,
	pendingEffects,
	retryDue,
	type Sighting,
	sighted,
	withEffect,
} from "./automationFires.js";
import {
	AUTOMATION_KIND,
	type AutomationIntent,
	type DroppedAutomation,
	judgeAutomationWrite,
	NOT_HOME,
} from "./automationJudge.js";
import { type AutomationRun, fireRun, LOG_MAX, logged, RunSchema } from "./automationLog.js";
import {
	clip,
	type Dropped,
	memberOf,
	outboxOf,
	QUEUE_FULL,
	QUEUE_MAX_EVENTS,
	QueueEntrySchema,
	type QueueState,
	told,
} from "./automationOutbox.js";
import {
	type AutomationActionPorts,
	type AutomationEffect,
	effectIssue,
	isEffect,
	runEffect,
} from "./automationRunner.js";
import { holeOwnerIssue, holeSpanOf, holeTexts, laneTellWhen, tellPlan } from "./automationText.js";
import type { ComputedFields, DerivedField } from "./computedFields.js";
import { crossingField, crossingFieldId, crossingSide } from "./crossingBand.js";

export { EFFECT_LATE_MS, EFFECT_RETRY_MS, EFFECT_WAIT_MS, FIRES_MAX } from "./automationFires.js";
export { type AutomationRun, RUN_OUTCOMES } from "./automationLog.js";
export {
	type AutomationOutbox,
	type OutboxEvent,
	QUEUE_MAX_BYTES,
	QUEUE_MAX_EVENTS,
} from "./automationOutbox.js";
export { AUTOMATION_KIND };

export type AutomationWritten =
	/** `records` holds null for a remove. */
	| { written: true; records: (OwnerRecord<Automation> | null)[]; dropped: readonly DroppedAutomation[] }
	| { written: false; reason: string; record?: OwnerRecord<Automation>; confirm?: string[]; issue?: OwnerIssue };

/** An id may spell a prototype key. */
const own = <T>(held: Record<string, T>, id: string): T | undefined => (Object.hasOwn(held, id) ? held[id] : undefined);
/** A filled effect parameter. */
const EFFECT_TEXT_MAX = 500;
/** Event fires remembered against a repeat. */
const FIRED_MAX = 256;
const NOT_READY = "its service was not ready";
const TOO_LATE = "too late after its trigger";
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

const SlotSchema = z.object({
	revision: z.number().int().positive(),
	incarnation: z.string(),
	/** The last slot handled, or when it was saved. */
	at: z.number(),
	/** Handled before the clock stepped back. */
	skip: z.number().optional(),
});
type Slot = z.infer<typeof SlotSchema>;

const CheckpointSchema = z.object({
	/** Tracks the record revision. */
	revision: z.number().int().positive(),
	incarnation: z.string(),
	fieldEpoch: z.string(),
	handledSeq: z.number().int().nonnegative(),
	/** The cool-down's clock. */
	firedAt: z.number().optional(),
});
type Checkpoint = z.infer<typeof CheckpointSchema>;

interface State {
	automations: Record<string, Checkpoint>;
	queue: QueueState;
	log: AutomationRun[];
	/** When each automation last ran. */
	ran: Record<string, number>;
	/** Oldest first. */
	fires: Fire[];
	/** Members of event fires already taken. */
	fired: string[];
	/** Each clock's last slot handled. */
	slots: Record<string, Slot>;
}

const EMPTY: State = {
	automations: {},
	queue: { lastAt: 0, events: [] },
	log: [],
	ran: {},
	fires: [],
	fired: [],
	slots: {},
};

/** Invalid log/baseline rows drop. */
const LooseStateSchema = z.object({
	automations: z.record(z.string(), z.unknown()).catch({}),
	queue: z.object({ lastAt: z.number().int(), events: z.array(z.unknown()) }).catch(EMPTY.queue),
	log: z.array(z.unknown()).catch([]),
	ran: z.record(z.string(), z.number()).catch({}),
	fires: z.array(z.unknown()).catch([]),
	fired: z.array(z.string()).catch([]),
	slots: z.record(z.string(), z.unknown()).catch({}),
});

/** A fire of another shape never runs. */
function restoreFires(rows: unknown[], pick: (rows: unknown[], schema: typeof FireSchema) => Fire[]): Fire[] {
	const fires = pick(rows, FireSchema);
	const lost = rows.length - fires.length;
	if (lost > 0) console.warn(`[automations] ${lost} stored runs of another shape were dropped and will not run`);
	return fires.slice(-FIRES_MAX);
}

function restore(raw: unknown): State {
	const loose = LooseStateSchema.parse(raw ?? EMPTY);
	const automations: State["automations"] = {};
	for (const [id, row] of Object.entries(loose.automations)) {
		const parsed = CheckpointSchema.safeParse(row);
		if (parsed.success) automations[id] = parsed.data;
	}
	const pick = <T>(rows: unknown[], schema: z.ZodType<T>): T[] =>
		rows.flatMap((row) => {
			const parsed = schema.safeParse(row);
			return parsed.success ? [parsed.data] : [];
		});
	// Remove 2027-01-15: a run time kept on its checkpoint alone.
	const ran = { ...loose.ran };
	for (const [id, row] of Object.entries(automations)) {
		if (row.firedAt !== undefined) ran[id] = Math.max(ran[id] ?? 0, row.firedAt);
	}
	return {
		automations,
		queue: {
			lastAt: loose.queue.lastAt,
			events: pick(loose.queue.events, QueueEntrySchema).slice(-QUEUE_MAX_EVENTS),
		},
		log: pick(loose.log, RunSchema).slice(-LOG_MAX),
		ran,
		fires: restoreFires(loose.fires, pick),
		fired: loose.fired.slice(-FIRED_MAX),
		slots: Object.fromEntries(
			Object.entries(loose.slots).flatMap(([id, row]) => {
				const parsed = SlotSchema.safeParse(row);
				return parsed.success ? [[id, parsed.data]] : [];
			}),
		),
	};
}

/** A device number, in words. */
export interface WatchedReading {
	/** The device's name, then the measure's. */
	label: string;
	device: string;
	measure: string;
	shown: (value: number) => string;
	/** In the owner's unit. */
	inUnit: (value: number) => number;
	/** Null while unread. */
	now: () => number | null;
}

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
}

export function createAutomations(deps: AutomationsDeps) {
	let state: State = restore(deps.state.load());

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

	function triggerIssue(body: Automation): string | null {
		if (body.trigger.kind === "event") {
			return deps.eventIssue ? deps.eventIssue(body.trigger) : "this Gateway holds no sources";
		}
		if (body.trigger.kind === "crossing") {
			const { device, measure } = body.trigger;
			if (!deps.reading?.(device, measure)) return "no such number on this Gateway";
			return deps.fields.check(crossingField(body.trigger));
		}
		if (isClock(body.trigger)) return clockIssue(body.trigger);
		const { field, becomes } = body.trigger;
		const type = deps.fields.typeOf(field);
		if (!type) return deps.fields.invalidOf(field) ?? "no such field";
		if (type.type === "boolean") return typeof becomes === "boolean" ? null : "this field is true or false";
		if (type.type === "choice") {
			return typeof becomes === "string" && type.members.includes(becomes)
				? null
				: `${String(becomes)} is not one of its values`;
		}
		return "only a field of choices or true and false can trigger";
	}

	/** First refused hole and span. */
	function holesIssue(body: Automation): OwnerIssue | null {
		const holes = deps.holes?.();
		const names = AUTOMATION_TRIGGER_NAMES[body.trigger.kind];
		for (const at of holeTexts(body)) {
			if (!hasHoles(at.text)) continue;
			if (!holes)
				return holeOwnerIssue(at, { start: 0, end: at.text.length, message: "holes cannot be read yet" });
			const issue = holes.issue(at.text, names);
			if (issue) return holeOwnerIssue(at, issue);
		}
		return null;
	}

	/** Why this Gateway cannot run it. */
	function automationIssue(body: Automation): string | null {
		const issue = triggerIssue(body);
		if (issue !== null) return issue;
		for (const action of body.actions) {
			const refused = isEffect(action) ? effectIssue(action, deps.actions) : null;
			if (refused !== null) return refused;
		}
		return holesIssue(body)?.message ?? null;
	}

	/** What the row and its events are called. */
	const sentenceOf = (body: Automation): string => {
		if (body.label) return body.label;
		if (body.trigger.kind === "event") return deps.eventSentence?.(body.trigger) ?? `${body.trigger.source} event`;
		if (body.trigger.kind === "crossing") {
			const { device, measure, direction, threshold } = body.trigger;
			const reading = deps.reading?.(device, measure);
			return `${reading?.label ?? `${device} ${measure}`} goes ${direction} ${reading?.shown(threshold) ?? threshold}`;
		}
		if (isClock(body.trigger)) return clockSentence(body.trigger);
		const field = deps.fields.get(body.trigger.field)?.body.label ?? body.trigger.field;
		return `${field} becomes ${String(body.trigger.becomes)}`;
	};

	/** The field a trigger watches, and the value that fires it. */
	const watched = (record: OwnerRecord<Automation>) => {
		const { trigger } = record.body;
		if (trigger.kind === "value") {
			return { ...trigger, label: deps.fields.get(trigger.field)?.body.label ?? trigger.field };
		}
		if (trigger.kind !== "crossing") return null;
		return {
			field: crossingFieldId(record.id),
			becomes: crossingSide(trigger),
			coolDownSec: trigger.coolDownSec,
			label: deps.reading?.(trigger.device, trigger.measure)?.label ?? `${trigger.device} ${trigger.measure}`,
		};
	};

	/** Names a fired trigger read. */
	const namesOf = (record: OwnerRecord<Automation>, value: string | number | boolean, label: string): FireNames => {
		const { trigger } = record.body;
		const names = trigger.kind === "crossing" ? crossingNames(trigger) : null;
		return names && Object.keys(names).length > 0 ? names : { value: { value }, field: { value: label } };
	};

	/** Empty when no sensor reads it. */
	const crossingNames = (trigger: CrossingTrigger): FireNames => {
		const reading = deps.reading?.(trigger.device, trigger.measure);
		if (!reading) return {};
		const now = reading.now();
		return {
			value:
				now === null
					? { value: null, shown: "unread" }
					: { value: reading.inUnit(now), shown: reading.shown(now) },
			device: { value: reading.device },
			measure: { value: reading.measure },
			threshold: { value: reading.inUnit(trigger.threshold), shown: reading.shown(trigger.threshold) },
		};
	};

	const commit = (next: State): boolean =>
		commitChecked(
			deps.state,
			next,
			(landed) => {
				state = landed;
			},
			{ label: "automation state" },
		).landed;

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

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

	/** A name's shown form, by name. */
	const fieldsOf = (names: FireNames): Record<string, string> =>
		Object.fromEntries(
			Object.entries(names).flatMap(([name, held]) => {
				const shown = held.shown ?? (typeof held.value === "string" ? held.value : undefined);
				return shown === undefined ? [] : [[name, shown]];
			}),
		);

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
		const effects = record.body.actions.some(isEffect);
		if (!tell && !effects) return false;
		const recorded: Fire = {
			...fired,
			member: at.member,
			incarnation: record.incarnation,
			revision: record.revision,
			names,
			effects: pendingEffects(record.body.actions),
			...(tell ? { tell } : {}),
		};
		const verdict = admit(work.fires, recorded, {
			// Each event carries its own.
			supersede: effects && record.body.trigger.kind !== "event",
			earlier: (member) => state.fires.some((stored) => stored.member === member),
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

	/** The next slot of every armed clock; an unlanded walk is retried. */
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

	/** Fires every slot that came round; a slot past its grace is only counted. */
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
			slots[record.id] = { ...kept, at: walk.at, ...(skip !== undefined && walk.at < skip ? { skip } : {}) };
		}
		const next: State = { ...state, slots, log: work.log, fires: work.fires };
		const landed = canonicalJson(next) === canonicalJson(state) || commit(next);
		pump();
		rearm(now, landed);
		return landed;
	}

	/** The effect in flight. */
	let running: { ref: EffectRef; done: Promise<void> } | null = null;
	/** The fill beside it. */
	let filling: Promise<void> | null = null;
	/** Effect outcomes, until their write lands; `unsent` sent nothing. */
	const spent = new Map<string, { ref: EffectRef; runs: AutomationRun[]; unsent?: string }>();
	/** Effects this process saw unable to start. */
	const sightings = new Map<string, Sighting>();

	const isRunning = (ref: EffectRef): boolean => running !== null && effectKey(running.ref) === effectKey(ref);

	/** Why a fire no longer runs. */
	const retireOf = (fire: Fire): AutomationRun | null => {
		const record = records.get(fire.automation);
		if (!record || record.incarnation !== fire.incarnation)
			return fireRun(fire, "uncertain", "the automation is gone");
		if (record.revision !== fire.revision) return fireRun(fire, "suppressed", "the automation changed");
		const issue = automationIssue(record.body);
		return issue === null ? null : fireRun(fire, "refused", issue);
	};

	/** Claimed effects' outcomes; `lost`: a claim with none never runs again. */
	const landClaims = (fire: Fire, held: Pick<State, "log" | "ran">, lost: boolean) => {
		let { log, ran } = held;
		let landed = fire;
		for (const action of effectsIn(fire, "claimed")) {
			const ref = { member: fire.member, action };
			if (isRunning(ref)) continue;
			const key = effectKey(ref);
			const outcome = spent.get(key);
			const kind = records.get(fire.automation)?.body.actions[action]?.kind;
			let runs = outcome?.runs ?? (lost ? [fireRun(fire, "uncertain", "interrupted mid-run", kind)] : null);
			if (outcome?.unsent !== undefined) {
				const now = deps.now();
				const seen = sightings.get(key);
				if (seen && !mayWait(seen, now)) runs = [fireRun(fire, "refused", outcome.unsent, kind)];
				else {
					sightings.set(key, sighted(seen, now, outcome.unsent, now + EFFECT_RETRY_MS));
					landed = withEffect(landed, action, "pending");
					continue;
				}
			}
			if (!runs) continue;
			log = runs.reduce(logged, log);
			if (runs.some((run) => run.outcome === "ran")) ran = { ...ran, [fire.automation]: fire.at };
			landed = withEffect(landed, action, "done");
		}
		return { fire: landed, log, ran };
	};

	/** Waits alone while it cannot start; refused once the wait has passed. */
	const effectStep = (effect: AutomationEffect, key: string, now: number): "go" | "wait" | { refused: string } => {
		const seen = sightings.get(key);
		if (!(deps.actions?.ready(effect) ?? true)) {
			if (seen && !mayWait(seen, now)) return { refused: NOT_READY };
			sightings.set(key, sighted(seen, now, NOT_READY));
			return "wait";
		}
		// Never attempted: a later wait starts at its first attempt.
		if (seen?.reason === NOT_READY) sightings.delete(key);
		else if (seen && !retryDue(seen, now)) return "wait";
		return "go";
	};

	const untold = ({ tell: _tell, waiting: _waiting, ...rest }: Fire): Fire => rest;

	/** Lands outcomes and queues every tell that is ready, in one write with the next claim; then runs it. */
	function pump(): void {
		if (stopped) return;
		const now = deps.now();
		const home = deps.isHome();
		let { queue, log, ran } = state;
		let fires: Fire[] = [];
		const goes = new Set<string>();
		let queued = false;
		const dropped: Dropped = new Map();
		/** Takes an unowned drop's row. */
		let droppedBy: Fire | null = null;
		for (const held of state.fires) {
			let fire: Fire;
			({ fire, log, ran } = landClaims(held, { log, ran }, true));
			const retired = retireOf(fire);
			if (retired) {
				// Retired once its effect lands.
				if (holdsClaim(fire)) fires.push(fire);
				else log = logged(log, retired);
				continue;
			}
			const record = records.get(fire.automation) as OwnerRecord<Automation>;
			for (const action of effectsIn(fire, "pending")) {
				const effect = record.body.actions[action];
				if (!effect || !isEffect(effect)) continue;
				const key = effectKey({ member: fire.member, action });
				const step =
					now - fire.at > EFFECT_LATE_MS
						? { refused: TOO_LATE }
						: AUTOMATION_ACTIONS[effect.kind].home && !home
							? { refused: NOT_HOME }
							: effectStep(effect, key, now);
				if (step === "go") goes.add(key);
				else if (step !== "wait") {
					log = logged(log, fireRun(fire, "refused", step.refused, effect.kind));
					fire = withEffect(fire, action, "done");
				}
			}
			if (fire.tell && !home) {
				log = logged(log, fireRun(fire, "refused", NOT_HOME, "tell_assistant"));
				fire = untold(fire);
			} else if (fire.tell && !fire.tell.fill) {
				const entry = { member: fire.member, when: fire.tell.when, fields: fire.tell.fields };
				const room = told(queue, entry, sentenceOf(record.body), now);
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
			if (!finished(fire)) fires.push(fire);
		}
		for (const [owner, count] of dropped) {
			const reason = `dropped ${count} older quiet event${count === 1 ? "" : "s"} for room`;
			const by = owner === null ? droppedBy : { automation: owner, seq: 0, at: now };
			if (by) log = logged(log, fireRun(by, "suppressed", reason, "tell_assistant"));
		}
		const effect = running ? null : nextEffect(fires, (ref) => goes.has(effectKey(ref)));
		if (effect) fires = claim(fires, effect);
		const toFill = filling ? null : nextFill(fires);
		const moved: State = { ...state, queue, log, ran, fires };
		// An unlanded pass is retried whole, its claim with it.
		if (canonicalJson(moved) !== canonicalJson(state) && !commit(moved)) return;
		for (const [key, { ref }] of [...spent]) {
			const claimed = state.fires.some(
				(held) => held.member === ref.member && held.effects[ref.action] === "claimed",
			);
			if (!claimed) spent.delete(key);
		}
		const open = new Set(
			state.fires.flatMap((held) =>
				Object.entries(held.effects)
					.filter(([, effect]) => effect !== "done")
					.map(([action]) => effectKey({ member: held.member, action: Number(action) })),
			),
		);
		for (const key of [...sightings.keys()]) if (!open.has(key)) sightings.delete(key);
		// The claim's runner registers first.
		if (effect) startEffect(effect);
		if (toFill) startFill(toFill);
		if (queued) deps.onQueued?.();
	}

	const heldWork = (member: string) => {
		const fire = state.fires.find((held) => held.member === member);
		const record = fire && records.get(fire.automation);
		return fire && record ? { fire, record } : null;
	};

	/** `thrown`: whether a throw pumps again. */
	const launch = (work: () => Promise<boolean>, end: () => void, thrown: boolean): Promise<void> =>
		Promise.resolve()
			.then(work)
			.catch((error) => {
				console.error("[automations] a run failed:", error);
				return thrown;
			})
			.then((moved) => {
				end();
				if (moved) pump();
			});

	function startEffect(ref: EffectRef): void {
		const held = heldWork(ref.member);
		if (!held) return;
		const done = launch(
			() => runOne(held.fire, held.record, ref.action),
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
			() => fill(held.fire, held.record),
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
				console.error("[automations] a fill failed:", error);
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
	async function runOne(fire: Fire, record: OwnerRecord<Automation>, action: number): Promise<boolean> {
		const ref = { member: fire.member, action };
		const runs: AutomationRun[] = [];
		const effect = record.body.actions[action];
		if (!effect || !isEffect(effect)) {
			spent.set(effectKey(ref), { ref, runs });
			return true;
		}
		const row = AUTOMATION_ACTIONS[effect.kind];
		if (row.home && !deps.isHome()) {
			spent.set(effectKey(ref), { ref, runs: [fireRun(fire, "refused", NOT_HOME, effect.kind)] });
			return true;
		}
		const filled = fillerOf(fire, runs);
		const texts: Record<string, string> = {};
		for (const { param, text } of holeTexts({ actions: [effect] })) {
			const params: readonly AutomationActionParam[] = row.params;
			const max = params.find((held) => held.name === param)?.max ?? EFFECT_TEXT_MAX;
			texts[param] = (await filled(text, effect.kind)).slice(0, max);
		}
		const done = deps.actions
			? await runEffect({ ...effect, ...texts }, deps.actions)
			: ({ outcome: "refused", reason: "this Gateway runs no such action" } as const);
		if (done.outcome === "not_started") {
			spent.set(effectKey(ref), { ref, runs: [], unsent: done.reason });
			return true;
		}
		runs.push(fireRun(fire, done.outcome, done.outcome === "ran" ? undefined : done.reason, effect.kind));
		spent.set(effectKey(ref), { ref, runs });
		return true;
	}

	/** A message's holes; false when nothing moved. */
	async function fill(fire: Fire, record: OwnerRecord<Automation>): Promise<boolean> {
		const runs: AutomationRun[] = [];
		const filled = fillerOf(fire, runs);
		const written = tellPlan(record.body).messages;
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
		let { log, ran } = state;
		const fires = state.fires.flatMap((held) => {
			const landed = landClaims(held, { log, ran }, false);
			({ log, ran } = landed);
			return finished(landed.fire) ? [] : [landed.fire];
		});
		const next: State = { ...state, log, ran, fires };
		if (canonicalJson(next) !== canonicalJson(state) && commit(next)) spent.clear();
	};

	const outbox = outboxOf(() => state.queue);

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
				const runs = record.body.actions.some(isEffect) || tellPlan(record.body).when !== null;
				if (!runs || fired.includes(member)) continue;
				fired.push(member);
				fire(work, record, { member, seq: 0, at }, names, fieldsOf(names));
			}
			if (fired.length === state.fired.length) return;
			const lost = fired.length - state.fired.length;
			if (commit({ ...state, fires: work.fires, fired: fired.slice(-FIRED_MAX), log: work.log })) pump();
			else console.warn(`[automations] ${lost} event fires were not recorded and will not run`);
		},
		/** Resolves once no run is in flight. */
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
		/** A trigger's names as they stand now; throws what a put would refuse. */
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
		/** Stops clocks and runs; awaits the run in flight. */
		async stop(): Promise<void> {
			stopped = true;
			if (clock) deps.timers?.clearTimer(clock.handle());
			clock = null;
			while (running || filling) await Promise.all([running?.done, filling]);
			landSpent();
		},
		/** Clear events, then drain; a repeat retries. */
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
