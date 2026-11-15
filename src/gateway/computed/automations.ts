// Queue and checkpoint, atomically.

import { z } from "zod";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { chainedTimer } from "../../shared/chained-timer.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import {
	AUTOMATION_TRIGGER_NAMES,
	AUTOMATIONS_MAX,
	type Automation,
	type AutomationRow,
	AutomationSchema,
	type AutomationTrigger,
	type ConsoleAutomationDeleteResult,
	type ConsoleAutomationPutResult,
	type CrossingTrigger,
	type EventTrigger,
	TELL_WHEN,
	type TellWhen,
} from "../../shared/schemasAutomation.js";
import { hasHoles, unescapedText } from "../../shared/text-holes.js";
import { createOwnerRecords, type OwnerIssue, type OwnerRecord } from "../ownerRecords.js";
import { CLOCK_GRACE_MS, clockIssue, clockSentence, clockShown, isClock, nextSlot } from "./automationClock.js";
import {
	AUTOMATION_KIND,
	type AutomationIntent,
	type DroppedAutomation,
	judgeAutomationWrite,
	NOT_HOME,
} from "./automationJudge.js";
import { type AutomationActionPorts, effectIssue, isEffect, runEffect } from "./automationRunner.js";
import { holeOwnerIssue, holeSpanOf, holeTexts, laneTellWhen, tellPlan } from "./automationText.js";
import type { ComputedFields, DerivedField } from "./computedFields.js";
import { ALERT_ID_PREFIX, crossingField, crossingFieldId, crossingSide } from "./thresholds.js";

export { AUTOMATION_KIND };

export type AutomationWritten =
	/** `records` holds null for a remove. */
	| { written: true; records: (OwnerRecord<Automation> | null)[]; dropped: readonly DroppedAutomation[] }
	| { written: false; reason: string; record?: OwnerRecord<Automation>; confirm?: string[]; issue?: OwnerIssue };

/** An id may spell a prototype key. */
const own = <T>(held: Record<string, T>, id: string): T | undefined => (Object.hasOwn(held, id) ? held[id] : undefined);
export const QUEUE_MAX_EVENTS = 256;
export const QUEUE_MAX_BYTES = 64 * 1024;
const LOG_MAX = 64;
/** Slots a clock catches up on in one pass. */
const CLOCK_STEPS_MAX = 2_000;
/** A bounded told field. */
const TOLD_FIELD_MAX = 1_000;
/** A filled effect parameter. */
const EFFECT_TEXT_MAX = 500;
/** Runs waiting on their effects. */
export const FIRES_MAX = 64;
/** Event fires remembered against a repeat. */
const FIRED_MAX = 256;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Unreadable bodies stay queued. */
const QueueEntrySchema = z.strictObject({ member: z.string(), at: z.number().int(), body: z.unknown() });
type QueueEntry = z.infer<typeof QueueEntrySchema>;
const EventBodySchema = z.strictObject({
	title: z.string(),
	fields: z.record(z.string(), z.string()),
	/** Absent: quietly. */
	when: z.enum(TELL_WHEN).optional(),
});

export interface OutboxEvent {
	id: string;
	at: number;
	title: string;
	fields: Record<string, string>;
	when: TellWhen;
}

/** What automations left for the assistant. */
export interface AutomationOutbox {
	/** Moves with every append. */
	revision: () => number;
	/** Oldest first. */
	events: () => OutboxEvent[];
}

export const RUN_OUTCOMES = ["ran", "refused", "uncertain", "suppressed"] as const;

const RunSchema = z.strictObject({
	automation: z.string(),
	seq: z.number().int(),
	at: z.number().int(),
	outcome: z.enum(RUN_OUTCOMES),
	reason: z.string().optional(),
	/** The action kind, for an effect. */
	action: z.string().optional(),
});
export type AutomationRun = z.infer<typeof RunSchema>;

/** A trigger that fired, waiting on its effects. */
const FireSchema = z.strictObject({
	member: z.string(),
	automation: z.string(),
	incarnation: z.string(),
	at: z.number().int(),
	/** What the trigger read, for its texts' holes. */
	names: z.record(z.string(), z.object({ value: z.unknown(), shown: z.string().optional() })).optional(),
	/** Set before the first effect; never run again. */
	claimed: z.boolean().optional(),
});
type Fire = z.infer<typeof FireSchema>;
type FireNames = NonNullable<Fire["names"]>;

const SlotSchema = z.object({
	revision: z.number().int().positive(),
	incarnation: z.string(),
	/** The last slot handled, or when it was saved. */
	at: z.number(),
	firedAt: z.number().optional(),
});
type Slot = z.infer<typeof SlotSchema>;

const CheckpointSchema = z.object({
	/** Tracks the record revision. */
	revision: z.number().int().positive(),
	incarnation: z.string(),
	fieldEpoch: z.string(),
	handledSeq: z.number().int().nonnegative(),
	/** Queue refusals stay pending. */
	blockedSeq: z.number().int().positive().optional(),
	firedAt: z.number().optional(),
});
type Checkpoint = z.infer<typeof CheckpointSchema>;

interface State {
	automations: Record<string, Checkpoint>;
	queue: { lastAt: number; events: QueueEntry[] };
	log: AutomationRun[];
	/** When each event automation last woke. */
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
	return {
		automations,
		queue: {
			lastAt: loose.queue.lastAt,
			events: pick(loose.queue.events, QueueEntrySchema).slice(-QUEUE_MAX_EVENTS),
		},
		log: pick(loose.log, RunSchema).slice(-LOG_MAX),
		ran: loose.ran,
		fires: pick(loose.fires, FireSchema).slice(-FIRES_MAX),
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

const queueBytes = (events: readonly QueueEntry[]) => Buffer.byteLength(JSON.stringify(events));

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

	/** Null when the outbox has no room. */
	const told = (
		queue: State["queue"],
		entry: { member: string; when: TellWhen; fields: Record<string, string> },
		sentence: string,
		now: number,
	): State["queue"] | null => {
		const at = Math.max(now, queue.lastAt + 1);
		const event: QueueEntry = {
			member: entry.member,
			at,
			body: {
				title: sentence,
				...(entry.when === "now" ? { when: "now" } : {}),
				fields: { automation: sentence, ...entry.fields },
			},
		};
		const events = [...queue.events.filter((held) => now - held.at < RETENTION_MS), event];
		if (events.length > QUEUE_MAX_EVENTS || queueBytes(events) > QUEUE_MAX_BYTES) return null;
		return { lastAt: at, events };
	};

	const QUEUE_FULL = "the sensors queue is full";

	const commit = (next: State): boolean =>
		commitChecked(
			deps.state,
			next,
			(landed) => {
				state = landed;
			},
			{ label: "automation state" },
		).landed;

	const logged = (log: readonly AutomationRun[], run: AutomationRun) => [...log, run].slice(-LOG_MAX);

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

	/** Baselines whose write has not landed. */
	let unsaved: State["automations"] = {};

	/** What one pass will commit. */
	interface Work {
		queue: State["queue"];
		log: AutomationRun[];
		fires: Fire[];
		queued: boolean;
	}

	const workOf = (): Work => ({ queue: state.queue, log: state.log, fires: [...state.fires], queued: false });

	/** Tells or queues a run; `blocked` when the outbox has no room. */
	const fire = (
		work: Work,
		record: OwnerRecord<Automation>,
		at: { member: string; seq: number; at: number; now: number },
		names: FireNames,
		fields: Record<string, string>,
	): "fired" | "idle" | "blocked" => {
		const plan = tellPlan(record.body);
		// A message with holes is told by the run.
		const runs = plan.filling || record.body.actions.some(isEffect);
		const run = (outcome: AutomationRun["outcome"], reason?: string): AutomationRun => ({
			automation: record.id,
			seq: at.seq,
			at: at.at,
			outcome,
			...(reason ? { reason } : {}),
		});
		let fired = false;
		if (plan.when !== null && !plan.filling && !deps.isHome()) {
			work.log = logged(work.log, run("refused", NOT_HOME));
		} else if (plan.when !== null && !plan.filling) {
			const sent: Record<string, string> = { ...fields };
			if (plan.messages.length > 0) sent.message = plan.messages.map(unescapedText).join("\n");
			const entry = { member: at.member, when: plan.when, fields: sent };
			const next = told(work.queue, entry, sentenceOf(record.body), at.now);
			if (!next) return "blocked";
			work.queue = next;
			work.log = logged(work.log, run("ran"));
			work.queued = true;
			fired = true;
		}
		if (runs && work.fires.length >= FIRES_MAX) {
			work.log = logged(work.log, run("refused", "too many runs are waiting"));
		} else if (runs) {
			work.fires.push({
				member: at.member,
				automation: record.id,
				incarnation: record.incarnation,
				at: at.at,
				names,
			});
			fired = true;
		}
		return fired ? "fired" : "idle";
	};

	/** Replays transitions idempotently. */
	function drain(): boolean {
		const now = deps.now();
		const work = workOf();
		const checkpoints: State["automations"] = {};
		for (const record of records.list()) {
			// The lane runs event triggers.
			const trigger = watched(record);
			if (!trigger || !armed(record)) continue;
			const { field, becomes } = trigger;
			const saved = own(state.automations, record.id);
			const held = unsaved[record.id];
			const was = held?.revision === record.revision && saved?.revision !== record.revision ? held : saved;
			const current = deps.fields.stateOf(field);
			if (!current) {
				if (was) checkpoints[record.id] = was;
				continue;
			}
			const carried =
				was?.incarnation === record.incarnation && was.firedAt !== undefined ? { firedAt: was.firedAt } : {};
			if (!was || was.revision !== record.revision || was.incarnation !== record.incarnation) {
				// Record changes reset baseline.
				checkpoints[record.id] = {
					revision: record.revision,
					incarnation: record.incarnation,
					fieldEpoch: current.epoch,
					handledSeq: current.seq,
					...carried,
				};
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
			const run = (
				seq: number,
				when: number,
				outcome: AutomationRun["outcome"],
				reason?: string,
			): AutomationRun => ({
				automation: record.id,
				seq,
				at: when,
				outcome,
				...(reason ? { reason } : {}),
			});
			const pending = current.changes.filter((row) => row.seq > at.handledSeq);
			const oldest = pending[0]?.seq ?? current.seq + 1;
			if (current.seq > at.handledSeq && oldest > at.handledSeq + 1) {
				const missed = oldest - at.handledSeq - 1;
				work.log = logged(work.log, run(oldest - 1, now, "uncertain", `missed ${missed} changes`));
				at = { ...at, handledSeq: oldest - 1, blockedSeq: undefined };
			}
			for (const row of pending) {
				const crossed = row.value === becomes && row.previous !== becomes;
				const handled = { ...at, handledSeq: row.seq, blockedSeq: undefined };
				if (!crossed) {
					at = handled;
					continue;
				}
				if (at.firedAt !== undefined && row.at - at.firedAt < trigger.coolDownSec * 1000) {
					work.log = logged(work.log, run(row.seq, row.at, "suppressed", "cooling down"));
					at = handled;
					continue;
				}
				const member = `automation:${record.id}:${record.incarnation}:${current.epoch}:${row.seq}`;
				const names = namesOf(record, row.value, trigger.label);
				const fields = { field: trigger.label, value: names.value?.shown ?? String(row.value) };
				const outcome = fire(work, record, { member, seq: row.seq, at: row.at, now }, names, fields);
				if (outcome === "blocked") {
					if (at.blockedSeq !== row.seq)
						work.log = logged(work.log, run(row.seq, row.at, "refused", QUEUE_FULL));
					at = { ...at, blockedSeq: row.seq };
					break;
				}
				at = outcome === "fired" ? { ...handled, firedAt: row.at } : handled;
			}
			checkpoints[record.id] = at;
		}
		const next: State = { ...state, automations: checkpoints, queue: work.queue, log: work.log, fires: work.fires };
		if (canonicalJson(next) === canonicalJson(state)) {
			pump();
			return true;
		}
		const landed = commit(next);
		unsaved = landed ? {} : checkpoints;
		if (landed && work.queued) deps.onQueued?.();
		pump();
		return landed;
	}

	let clock: { handle: () => TimerHandle } | null = null;
	let stopped = false;

	/** The next slot of every armed clock, from the walk's own `now`. */
	const rearm = (now: number): void => {
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
		clock = chainedTimer(deps.timers, Math.max(0, Math.min(...nexts) - now), () => {
			clock = null;
			tick();
		});
	};

	/** Fires every slot that came round; a slot past its grace is only counted. */
	function tick(): boolean {
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
			let { at, firedAt } = held;
			let missed = 0;
			let steps = 0;
			for (let next = nextSlot(trigger, at); next !== null && next <= now; next = nextSlot(trigger, at)) {
				at = next;
				if (++steps > CLOCK_STEPS_MAX) {
					// Too far behind to count.
					at = now;
					break;
				}
				if (now - next > CLOCK_GRACE_MS) {
					missed += 1;
					continue;
				}
				const member = `automation:${record.id}:${record.incarnation}:slot:${next}`;
				const shown = clockShown(trigger, next);
				const outcome = fire(
					work,
					record,
					{ member, seq: 0, at: next, now },
					{ time: { value: next, shown } },
					{ time: shown },
				);
				if (outcome === "blocked") {
					work.log = logged(work.log, {
						automation: record.id,
						seq: 0,
						at: next,
						outcome: "refused",
						reason: QUEUE_FULL,
					});
				}
				if (outcome === "fired") firedAt = next;
			}
			if (missed > 0) {
				const reason = `missed ${missed} slot${missed === 1 ? "" : "s"}`;
				work.log = logged(work.log, { automation: record.id, seq: 0, at: now, outcome: "uncertain", reason });
			}
			slots[record.id] = { ...held, at, ...(firedAt === undefined ? {} : { firedAt }) };
		}
		const next: State = { ...state, slots, queue: work.queue, log: work.log, fires: work.fires };
		const landed = canonicalJson(next) === canonicalJson(state) || commit(next);
		if (landed && work.queued) deps.onQueued?.();
		pump();
		rearm(now);
		return landed;
	}

	let running: Promise<void> | null = null;

	const effectRun = (
		fire: Fire,
		outcome: AutomationRun["outcome"],
		reason?: string,
		action?: string,
	): AutomationRun => ({
		automation: fire.automation,
		seq: 0,
		at: deps.now(),
		outcome,
		...(reason ? { reason } : {}),
		...(action ? { action } : {}),
	});

	/** Retires a fire after its runs. */
	const finish = (fire: Fire, runs: readonly AutomationRun[], queue: State["queue"] = state.queue): boolean =>
		commit({
			...state,
			queue,
			fires: state.fires.filter((held) => held.member !== fire.member),
			log: runs.reduce(logged, state.log),
			ran: runs.some((run) => run.outcome === "ran") ? { ...state.ran, [fire.automation]: fire.at } : state.ran,
		});

	/** False when nothing moved. */
	async function runFire(fire: Fire): Promise<boolean> {
		const ports = deps.actions;
		const record = records.get(fire.automation);
		if (!record || record.incarnation !== fire.incarnation) {
			return finish(fire, [effectRun(fire, "uncertain", "the automation is gone")]);
		}
		// Claimed before any effect.
		const claimed = state.fires.map((held) => (held.member === fire.member ? { ...held, claimed: true } : held));
		if (!commit({ ...state, fires: claimed })) return false;
		const runs: AutomationRun[] = [];
		const names = fire.names ?? {};
		const holes = deps.holes?.();
		/** Failed hole prints a mark, logs once. */
		const filled = async (text: string, action: string): Promise<string> => {
			if (!holes || !hasHoles(text)) return unescapedText(text);
			const read = await holes.fill(text, names);
			if (read.failed > 0) {
				runs.push(effectRun(fire, "uncertain", `${read.failed} of its holes could not be read`, action));
			}
			return read.text;
		};
		for (const action of record.body.actions) {
			if (!isEffect(action)) continue;
			const texts: Record<string, string> = {};
			for (const { param, text } of holeTexts({ actions: [action] })) {
				texts[param] = (await filled(text, action.kind)).slice(0, EFFECT_TEXT_MAX);
			}
			const done = ports
				? await runEffect({ ...action, ...texts }, ports)
				: ({ outcome: "refused", reason: "this Gateway runs no such action" } as const);
			runs.push(effectRun(fire, done.outcome, done.outcome === "ran" ? undefined : done.reason, action.kind));
		}
		const plan = tellPlan(record.body);
		// Holeless messages told at fire, except event fires.
		const tells = record.body.trigger.kind === "event" || plan.filling ? plan.when : null;
		if (tells === null) return finish(fire, runs);
		if (!deps.isHome()) return finish(fire, [...runs, effectRun(fire, "refused", NOT_HOME, "tell_assistant")]);
		const messages: string[] = [];
		for (const message of plan.messages) messages.push(await filled(message, "tell_assistant"));
		const fields: Record<string, string> = {};
		for (const [name, held] of Object.entries(names)) {
			const shown = held.shown ?? (typeof held.value === "string" ? held.value : undefined);
			if (shown !== undefined) fields[name] = shown.slice(0, TOLD_FIELD_MAX);
		}
		if (messages.length > 0) fields.message = messages.join("\n").slice(0, TOLD_FIELD_MAX);
		const queue = told(
			state.queue,
			{ member: fire.member, when: tells, fields },
			sentenceOf(record.body),
			deps.now(),
		);
		if (!queue) return finish(fire, [...runs, effectRun(fire, "refused", QUEUE_FULL, "tell_assistant")]);
		const landed = finish(fire, [...runs, effectRun(fire, "ran", undefined, "tell_assistant")], queue);
		if (landed) deps.onQueued?.();
		return landed;
	}

	/** One fire at a time, oldest first. */
	function pump(): void {
		if (running) return;
		const fire = state.fires.find((held) => !held.claimed);
		if (!fire) return;
		running = runFire(fire)
			.catch((error) => {
				console.error("[automations] a run failed:", error);
				return false;
			})
			.then((moved) => {
				running = null;
				if (moved) pump();
			});
	}

	const outbox: AutomationOutbox = {
		revision: () => state.queue.lastAt,
		/** Unreadable entries stay hidden. */
		events: () =>
			state.queue.events.flatMap((event) => {
				const body = EventBodySchema.safeParse(event.body);
				if (!body.success) return [];
				const { when = "quietly", ...shown } = body.data;
				return [{ id: event.member, at: event.at, ...shown, when }];
			}),
	};

	/** The device whose Alerts row wrote it. */
	const deviceOf = (record: OwnerRecord<Automation>): string | undefined => {
		const { trigger } = record.body;
		if (!record.id.startsWith(ALERT_ID_PREFIX)) return undefined;
		if (trigger.kind === "crossing") return trigger.device;
		if (trigger.kind !== "value") return undefined;
		const read = deps.fields.get(trigger.field)?.body.nodes[0];
		return read?.kind === "field" && read.ref.source === "device" ? read.ref.device : undefined;
	};

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
		const lastRanAt = own(state.automations, record.id)?.firedAt ?? slot?.firedAt ?? own(state.ran, record.id);
		const device = deviceOf(record);
		const { trigger } = record.body;
		const nextRunAt = isClock(trigger) && slot && armed(record) ? nextSlot(trigger, slot.at) : null;
		return {
			id: record.id,
			revision: record.revision,
			automation: record.body,
			sentence: sentenceOf(record.body),
			...(invalid === null ? {} : { invalid }),
			...(lastRanAt === undefined ? {} : { lastRanAt }),
			...(device === undefined ? {} : { device }),
			...(nextRunAt === null ? {} : { nextRunAt }),
		};
	};

	/** A revived id starts unrun. */
	const forgetRan = (ids: readonly string[]): void => {
		if (!ids.some((id) => Object.hasOwn(state.ran, id))) return;
		commit({ ...state, ran: Object.fromEntries(Object.entries(state.ran).filter(([id]) => !ids.includes(id))) });
	};

	/** Every row lands, or none. */
	function write(intent: AutomationIntent): AutomationWritten {
		const held = records.list();
		const verdict = judgeAutomationWrite(intent, {
			held,
			count: records.count(),
			max: AUTOMATIONS_MAX,
			isHome: deps.isHome(),
			issue: automationIssue,
		});
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

	// A claimed fire never runs again.
	const interrupted = state.fires.filter((fire) => fire.claimed);
	if (interrupted.length > 0) {
		commit({
			...state,
			fires: state.fires.filter((fire) => !fire.claimed),
			log: interrupted
				.map((fire) => effectRun(fire, "uncertain", "interrupted mid-run"))
				.reduce(logged, state.log),
		});
	}

	drain();
	tick();

	return {
		list: () => records.list(),
		rows: (): AutomationRow[] => records.list().map(rowOf),
		write,
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
		/** Runs matching event effects. */
		fireEvents(matched: readonly { automation: string; key: string; names: FireNames }[], at: number): void {
			const fires = [...state.fires];
			const fired = [...state.fired];
			let log = state.log;
			for (const { automation, key, names } of matched) {
				const record = records.get(automation);
				if (!record || !armed(record)) continue;
				const member = `automation:${record.id}:${record.incarnation}:${key}`;
				const runs = record.body.actions.some(isEffect) || tellPlan(record.body).when !== null;
				if (!runs || fired.includes(member)) continue;
				fired.push(member);
				const fire: Fire = { member, automation, incarnation: record.incarnation, at, names };
				if (fires.length >= FIRES_MAX)
					log = logged(log, effectRun(fire, "refused", "too many runs are waiting"));
				else fires.push(fire);
			}
			if (fired.length === state.fired.length) return;
			if (commit({ ...state, fires, fired: fired.slice(-FIRED_MAX), log })) pump();
		},
		/** Resolves once no run is in flight. */
		async settled(): Promise<void> {
			while (running) await running;
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
		/** No clock fires after this. */
		stop: (): void => {
			stopped = true;
			if (clock) deps.timers?.clearTimer(clock.handle());
			clock = null;
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
