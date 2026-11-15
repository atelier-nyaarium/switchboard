// Queue and checkpoint, atomically.

import { createHash } from "node:crypto";
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
	TELL_WHEN,
	type TellWhen,
} from "../../shared/schemasAutomation.js";
import { hasHoles, unescapedText, unreadText } from "../../shared/text-holes.js";
import { createOwnerRecords, type OwnerIssue, type OwnerRecord } from "../ownerRecords.js";
import { clockIssue, clockSentence, clockShown, isClock, nextSlot, walkSlots } from "./automationClock.js";
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
import { crossingField, crossingFieldId, crossingSide } from "./crossingBand.js";

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
/** A told title or field. */
const TOLD_FIELD_MAX = 1_000;
/** A filled effect parameter. */
const EFFECT_TEXT_MAX = 500;
/** Runs waiting on their effects. */
export const FIRES_MAX = 64;
/** Event fires remembered against a repeat. */
const FIRED_MAX = 256;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A walk whose write failed is retried after this. */
const CLOCK_RETRY_MS = 30_000;
const MEMBER_MAX = 256;
const FIELD_NAME_MAX = 64;
const FIELDS_MAX = 32;

/** A long member keeps its head and a digest of the whole. */
function memberOf(...parts: (string | number)[]): string {
	const member = ["automation", ...parts].join(":");
	if (member.length <= MEMBER_MAX) return member;
	const digest = createHash("sha256").update(member).digest("hex");
	return `${member.slice(0, MEMBER_MAX - digest.length - 1)}:${digest}`;
}

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
/** Bounded as the lane's reader bounds an event. */
const EventBodySchema = z.strictObject({
	title: z.string().max(TOLD_FIELD_MAX),
	fields: z
		.record(z.string().max(FIELD_NAME_MAX), z.string().max(TOLD_FIELD_MAX))
		.refine((fields) => Object.keys(fields).length <= FIELDS_MAX),
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

/** A fired trigger awaiting its run. */
const FireSchema = z.strictObject({
	member: z.string(),
	automation: z.string(),
	incarnation: z.string(),
	/** The record as it fired; an edit retires the fire. */
	revision: z.number().int().positive(),
	/** The transition it answers; zero for a slot or an event. */
	seq: z.number().int().nonnegative(),
	at: z.number().int(),
	/** What the trigger read, for its texts' holes. */
	names: z.record(z.string(), z.object({ value: z.unknown(), shown: z.string().optional() })).optional(),
	/** Claimed before the first effect; never run again. */
	effects: z.enum(["claimed", "done"]).optional(),
	tell: z
		.strictObject({
			when: z.enum(TELL_WHEN),
			fields: z.record(z.string(), z.string()),
			/** Its messages' holes are unread. */
			fill: z.literal(true).optional(),
		})
		.optional(),
	/** The outbox had no room. */
	waiting: z.literal(true).optional(),
});
type Fire = z.infer<typeof FireSchema>;
type FireNames = NonNullable<Fire["names"]>;

const SlotSchema = z.object({
	revision: z.number().int().positive(),
	incarnation: z.string(),
	/** The last slot handled, or when it was saved. */
	at: z.number(),
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
	queue: { lastAt: number; events: QueueEntry[] };
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

	const clip = (text: string) => text.slice(0, TOLD_FIELD_MAX);

	/** Wakes nobody. */
	const isQuiet = (entry: QueueEntry): boolean => {
		const body = EventBodySchema.safeParse(entry.body);
		return body.success && body.data.when !== "now";
	};

	/** Quiet entries make room. */
	const told = (
		queue: State["queue"],
		entry: { member: string; when: TellWhen; fields: Record<string, string> },
		sentence: string,
		now: number,
	): { queue: State["queue"]; dropped: number } | null => {
		const at = Math.max(now, queue.lastAt + 1);
		const title = clip(sentence);
		const event: QueueEntry = {
			member: entry.member,
			at,
			body: {
				title,
				...(entry.when === "now" ? { when: "now" } : {}),
				fields: { automation: title, ...entry.fields },
			},
		};
		const events = [...queue.events.filter((held) => now - held.at < RETENTION_MS), event];
		let bytes = queueBytes(events);
		let dropped = 0;
		while (events.length > QUEUE_MAX_EVENTS || bytes > QUEUE_MAX_BYTES) {
			const quiet = events.findIndex((held, index) => index < events.length - 1 && isQuiet(held));
			if (quiet === -1) return null;
			const [gone] = events.splice(quiet, 1);
			// Entry and comma.
			bytes -= queueBytes([gone as QueueEntry]) - 1;
			dropped += 1;
		}
		return { queue: { lastAt: at, events }, dropped };
	};

	const QUEUE_FULL = "the automations outbox is full";

	const commit = (next: State): boolean =>
		commitChecked(
			deps.state,
			next,
			(landed) => {
				state = landed;
			},
			{ label: "automation state" },
		).landed;

	/** Refusal logged once per action. */
	const logged = (log: readonly AutomationRun[], run: AutomationRun): AutomationRun[] => {
		const last = log.findLast((held) => held.automation === run.automation && held.action === run.action);
		const standing = run.outcome === "refused" && last?.outcome === "refused" && last.reason === run.reason;
		return standing ? [...log] : [...log, run].slice(-LOG_MAX);
	};

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

	/** Baselines whose write has not landed. */
	let unsaved: State["automations"] = {};

	/** What one pass will commit. */
	interface Work {
		log: AutomationRun[];
		fires: Fire[];
	}

	const workOf = (): Work => ({ log: state.log, fires: [...state.fires] });

	const fireRun = (
		fire: Pick<Fire, "automation" | "seq" | "at">,
		outcome: AutomationRun["outcome"],
		reason?: string,
		action?: string,
	): AutomationRun => ({
		automation: fire.automation,
		seq: fire.seq,
		at: fire.at,
		outcome,
		...(reason ? { reason } : {}),
		...(action ? { action } : {}),
	});

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

	/** One unstarted effects fire per automation. */
	const replaceUnstarted = (work: Work, fire: Fire): void => {
		const older = work.fires.findIndex(
			(held) =>
				held.automation === fire.automation &&
				held.effects === undefined &&
				held.member !== running?.member &&
				held.member !== fire.member,
		);
		const held = work.fires[older];
		if (!held) return;
		work.log = logged(work.log, fireRun(held, "suppressed", "a newer run replaced it"));
		if (held.tell) work.fires[older] = { ...held, effects: "done" };
		else work.fires.splice(older, 1);
	};

	/** A fire waiting only on the outbox gives up its place. */
	const admit = (work: Work, fire: Fire, effects: boolean): boolean => {
		if (effects) replaceUnstarted(work, fire);
		if (work.fires.length >= FIRES_MAX) {
			const waiting = work.fires.findIndex((held) => held.waiting);
			if (waiting === -1) {
				work.log = logged(work.log, fireRun(fire, "refused", "too many runs are waiting"));
				return false;
			}
			work.fires.splice(waiting, 1);
		}
		work.fires.push(fire);
		return true;
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
		const effects = record.body.actions.some(isEffect);
		if (!tell && !effects) return false;
		const recorded: Fire = {
			...fired,
			member: at.member,
			incarnation: record.incarnation,
			revision: record.revision,
			names,
			...(tell ? { tell } : {}),
		};
		return admit(work, recorded, effects);
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
			const walk = walkSlots(trigger, held.at, now);
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
			slots[record.id] = { ...held, at: walk.at };
		}
		const next: State = { ...state, slots, log: work.log, fires: work.fires };
		const landed = canonicalJson(next) === canonicalJson(state) || commit(next);
		pump();
		rearm(now, landed);
		return landed;
	}

	/** The fire the run holds. */
	let running: { member: string; done: Promise<void> } | null = null;
	/** Effects that ran, until their write lands. */
	const spent = new Map<string, AutomationRun[]>();

	type Step =
		| { kind: "retire"; runs: AutomationRun[] }
		| { kind: "effects" | "fill" | "tell"; record: OwnerRecord<Automation> };

	/** What a fire waits on. */
	const stepOf = (fire: Fire): Step => {
		const retire = (outcome: AutomationRun["outcome"], reason: string, action?: string): Step => ({
			kind: "retire",
			runs: [fireRun(fire, outcome, reason, action)],
		});
		const record = records.get(fire.automation);
		if (!record || record.incarnation !== fire.incarnation) return retire("uncertain", "the automation is gone");
		if (record.revision !== fire.revision) return retire("suppressed", "the automation changed");
		const issue = automationIssue(record.body);
		if (issue !== null) return retire("refused", issue);
		if (fire.effects !== "done" && record.body.actions.some(isEffect)) return { kind: "effects", record };
		if (!fire.tell) return { kind: "retire", runs: [] };
		if (!deps.isHome()) return retire("refused", NOT_HOME, "tell_assistant");
		return { kind: fire.tell.fill ? "fill" : "tell", record };
	};

	const patched = (member: string, patch: Partial<Fire>): Fire[] =>
		state.fires.map((held) => (held.member === member ? { ...held, ...patch } : held));

	/** Effects, or a message's holes; false when nothing moved. */
	async function work(fire: Fire): Promise<boolean> {
		const step = stepOf(fire);
		if (step.kind !== "effects" && step.kind !== "fill") return false;
		const names = fire.names ?? {};
		const holes = deps.holes?.();
		const runs: AutomationRun[] = [];
		/** Failed hole prints a mark, logs once. */
		const filled = async (text: string, action: string): Promise<string> => {
			if (!hasHoles(text)) return unescapedText(text);
			if (!holes) {
				runs.push(fireRun(fire, "uncertain", "its holes cannot be read yet", action));
				return unreadText(text);
			}
			const read = await holes.fill(text, names);
			if (read.failed > 0) {
				runs.push(fireRun(fire, "uncertain", `${read.failed} of its holes could not be read`, action));
			}
			return read.text;
		};
		if (step.kind === "effects") {
			// Claimed before any effect.
			if (!commit({ ...state, fires: patched(fire.member, { effects: "claimed" }) })) return false;
			const ports = deps.actions;
			for (const action of step.record.body.actions) {
				if (!isEffect(action)) continue;
				const row = AUTOMATION_ACTIONS[action.kind];
				if (row.home && !deps.isHome()) {
					runs.push(fireRun(fire, "refused", NOT_HOME, action.kind));
					continue;
				}
				const texts: Record<string, string> = {};
				for (const { param, text } of holeTexts({ actions: [action] })) {
					const params: readonly AutomationActionParam[] = row.params;
					const max = params.find((held) => held.name === param)?.max ?? EFFECT_TEXT_MAX;
					texts[param] = (await filled(text, action.kind)).slice(0, max);
				}
				const done = ports
					? await runEffect({ ...action, ...texts }, ports)
					: ({ outcome: "refused", reason: "this Gateway runs no such action" } as const);
				runs.push(fireRun(fire, done.outcome, done.outcome === "ran" ? undefined : done.reason, action.kind));
			}
			// The pump lands them.
			spent.set(fire.member, runs);
			return true;
		}
		const written = tellPlan(step.record.body).messages;
		const messages: string[] = [];
		for (const message of written) messages.push(await filled(message, "tell_assistant"));
		if (!fire.tell) return false;
		const tell = { when: fire.tell.when, fields: withMessage(fire.tell.fields, messages, written) };
		return commit({ ...state, fires: patched(fire.member, { tell }), log: runs.reduce(logged, state.log) });
	}

	/** Claimed fire's runs. */
	const landClaim = (fire: Fire, runs: readonly AutomationRun[], held: Pick<State, "log" | "ran">) => ({
		fire: { ...fire, effects: "done" as const },
		log: runs.reduce(logged, held.log),
		ran: runs.some((run) => run.outcome === "ran") ? { ...held.ran, [fire.automation]: fire.at } : held.ran,
	});

	/** Unready effects wait unclaimed. */
	const effectsReady = (body: Automation): boolean =>
		body.actions.every(
			(action) =>
				!isEffect(action) ||
				(AUTOMATION_ACTIONS[action.kind].home && !deps.isHome()) ||
				(deps.actions?.ready(action) ?? true),
		);

	/** Queues every tell that is ready, in one write; then runs one fire. */
	function pump(): void {
		if (stopped) return;
		const now = deps.now();
		let { queue, log, ran } = state;
		const fires: Fire[] = [];
		let queued = false;
		let next: Fire | null = null;
		/** Quiet events dropped. */
		let dropped = 0;
		let droppedBy: Fire | null = null;
		for (const held of state.fires) {
			if (running?.member === held.member) {
				fires.push(held);
				continue;
			}
			let fire = held;
			if (fire.effects === "claimed") {
				// A claim with no run left never runs again.
				const runs = spent.get(fire.member) ?? [fireRun(fire, "uncertain", "interrupted mid-run")];
				({ fire, log, ran } = landClaim(fire, runs, { log, ran }));
			}
			const step = stepOf(fire);
			if (step.kind === "retire") {
				log = step.runs.reduce(logged, log);
				continue;
			}
			if (step.kind === "effects" && !effectsReady(step.record.body)) {
				fires.push(fire);
				continue;
			}
			if (step.kind !== "tell" || !fire.tell) {
				fires.push(fire);
				next ??= fire;
				continue;
			}
			const entry = { member: fire.member, when: fire.tell.when, fields: fire.tell.fields };
			const room = told(queue, entry, sentenceOf(step.record.body), now);
			if (!room) {
				if (!fire.waiting) log = logged(log, fireRun(fire, "refused", QUEUE_FULL, "tell_assistant"));
				fires.push({ ...fire, waiting: true });
				continue;
			}
			queue = room.queue;
			if (room.dropped > 0) {
				dropped += room.dropped;
				droppedBy = fire;
			}
			log = logged(log, fireRun(fire, "ran", undefined, "tell_assistant"));
			ran = { ...ran, [fire.automation]: fire.at };
			queued = true;
		}
		if (droppedBy) {
			const reason = `dropped ${dropped} older quiet event${dropped === 1 ? "" : "s"} for room`;
			log = logged(log, fireRun(droppedBy, "suppressed", reason, "tell_assistant"));
		}
		const moved: State = { ...state, queue, log, ran, fires };
		// An unlanded pass is retried whole.
		if (canonicalJson(moved) !== canonicalJson(state) && !commit(moved)) return;
		for (const member of [...spent.keys()]) {
			if (!state.fires.some((held) => held.member === member && held.effects === "claimed")) spent.delete(member);
		}
		if (queued) deps.onQueued?.();
		if (!next || running) return;
		const done = work(next)
			.catch((error) => {
				console.error("[automations] a run failed:", error);
				return true;
			})
			.then((moved) => {
				running = null;
				if (moved) pump();
			});
		running = { member: next.member, done };
	}

	/** Runs in one write. */
	const landSpent = (): void => {
		let { log, ran } = state;
		let changed = false;
		const fires = state.fires.flatMap((held) => {
			const runs = held.effects === "claimed" ? spent.get(held.member) : undefined;
			if (!runs) return [held];
			const landed = landClaim(held, runs, { log, ran });
			({ log, ran } = landed);
			changed = true;
			return held.tell ? [landed.fire] : [];
		});
		if (changed && commit({ ...state, log, ran, fires })) spent.clear();
	};

	const outbox: AutomationOutbox = {
		revision: () => state.queue.lastAt,
		/** Unreadable entries stay hidden. */
		events: () =>
			state.queue.events.flatMap((event) => {
				const body = EventBodySchema.safeParse(event.body);
				if (!body.success || event.member.length > MEMBER_MAX) return [];
				const { when = "quietly", ...shown } = body.data;
				return [{ id: event.member, at: event.at, ...shown, when }];
			}),
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
		const lastRanAt = own(state.ran, record.id);
		const { trigger } = record.body;
		const current = slot?.revision === record.revision ? slot : undefined;
		const nextRunAt = isClock(trigger) && current && armed(record) ? nextSlot(trigger, current.at) : null;
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
			while (running) await running.done;
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
			while (running) await running.done;
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
