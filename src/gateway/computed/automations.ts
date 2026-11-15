// Queue and checkpoint, atomically.

import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import {
	AUTOMATIONS_MAX,
	type Automation,
	type AutomationRow,
	AutomationSchema,
	type ConsoleAutomationDeleteResult,
	type ConsoleAutomationPutResult,
	type EventTrigger,
	TELL_WHEN,
	type TellWhen,
	tellWhen,
} from "../../shared/schemasAutomation.js";
import { createOwnerRecords, type OwnerRecord } from "../ownerRecords.js";
import {
	AUTOMATION_KIND,
	type AutomationIntent,
	type DroppedAutomation,
	judgeAutomationWrite,
	NOT_HOME,
} from "./automationJudge.js";
import { type AutomationActionPorts, effectIssue, isEffect, runEffect } from "./automationRunner.js";
import type { ComputedFields, DerivedField } from "./computedFields.js";
import { ALERT_ID_PREFIX, crossingField, crossingFieldId, crossingSide } from "./thresholds.js";

export { AUTOMATION_KIND };

export type AutomationWritten =
	/** `records` holds null for a remove. */
	| { written: true; records: (OwnerRecord<Automation> | null)[]; dropped: readonly DroppedAutomation[] }
	| { written: false; reason: string; record?: OwnerRecord<Automation>; confirm?: string[] };

/** An id may spell a prototype key. */
const own = <T>(held: Record<string, T>, id: string): T | undefined => (Object.hasOwn(held, id) ? held[id] : undefined);
export const QUEUE_MAX_EVENTS = 256;
export const QUEUE_MAX_BYTES = 64 * 1024;
const LOG_MAX = 64;
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
	/** Set before the first effect; never run again. */
	claimed: z.boolean().optional(),
});
type Fire = z.infer<typeof FireSchema>;

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
}

const EMPTY: State = { automations: {}, queue: { lastAt: 0, events: [] }, log: [], ran: {}, fires: [], fired: [] };

/** Invalid log/baseline rows drop. */
const LooseStateSchema = z.object({
	automations: z.record(z.string(), z.unknown()).catch({}),
	queue: z.object({ lastAt: z.number().int(), events: z.array(z.unknown()) }).catch(EMPTY.queue),
	log: z.array(z.unknown()).catch([]),
	ran: z.record(z.string(), z.number()).catch({}),
	fires: z.array(z.unknown()).catch([]),
	fired: z.array(z.string()).catch([]),
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
	};
}

/** A device number, in words. */
export interface WatchedReading {
	label: string;
	shown: (value: number) => string;
	/** Null while unread. */
	now: () => number | null;
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
}

const queueBytes = (events: readonly QueueEntry[]) => Buffer.byteLength(JSON.stringify(events));

export function createAutomations(deps: AutomationsDeps) {
	let state: State = restore(deps.state.load());

	const store = createOwnerRecords<Automation>({
		store: deps.records,
		kinds: { [AUTOMATION_KIND]: StoredAutomationSchema },
		max: AUTOMATIONS_MAX,
		newIncarnation: deps.newIncarnation,
		refusal: (candidate) => automationIssue(candidate.body),
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

	/** Why this Gateway cannot run it. */
	function automationIssue(body: Automation): string | null {
		const issue = triggerIssue(body);
		if (issue !== null) return issue;
		for (const action of body.actions) {
			const refused = isEffect(action) ? effectIssue(action, deps.actions) : null;
			if (refused !== null) return refused;
		}
		return null;
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

	/** What a fired trigger read. */
	const readOf = (record: OwnerRecord<Automation>, fallback: string): string => {
		const { trigger } = record.body;
		if (trigger.kind !== "crossing") return fallback;
		const reading = deps.reading?.(trigger.device, trigger.measure);
		const now = reading?.now() ?? null;
		return reading && now !== null ? reading.shown(now) : fallback;
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

	const logged = (log: readonly AutomationRun[], run: AutomationRun) => [...log, run].slice(-LOG_MAX);

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

	/** Baselines whose write has not landed. */
	let unsaved: State["automations"] = {};

	/** Replays transitions idempotently. */
	function drain(): boolean {
		const now = deps.now();
		let { queue, log } = state;
		const fires = [...state.fires];
		let queued = false;
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
				log = logged(log, run(oldest - 1, now, "uncertain", `missed ${missed} changes`));
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
					log = logged(log, run(row.seq, row.at, "suppressed", "cooling down"));
					at = handled;
					continue;
				}
				const member = `automation:${record.id}:${record.incarnation}:${current.epoch}:${row.seq}`;
				const tells = tellWhen(record.body);
				const effects = record.body.actions.some(isEffect);
				let fired = false;
				if (tells !== null && !deps.isHome()) {
					log = logged(log, run(row.seq, row.at, "refused", NOT_HOME));
				} else if (tells !== null) {
					const appendAt = Math.max(now, queue.lastAt + 1);
					const sentence = sentenceOf(record.body);
					const event: QueueEntry = {
						member,
						at: appendAt,
						body: {
							title: sentence,
							...(tells === "now" ? { when: "now" } : {}),
							fields: {
								automation: sentence,
								field: trigger.label,
								value: readOf(record, String(row.value)),
							},
						},
					};
					const events = [...queue.events.filter((entry) => now - entry.at < RETENTION_MS), event];
					if (events.length > QUEUE_MAX_EVENTS || queueBytes(events) > QUEUE_MAX_BYTES) {
						if (at.blockedSeq !== row.seq)
							log = logged(log, run(row.seq, row.at, "refused", "the sensors queue is full"));
						at = { ...at, blockedSeq: row.seq };
						break;
					}
					queue = { lastAt: appendAt, events };
					log = logged(log, run(row.seq, row.at, "ran"));
					fired = true;
					queued = true;
				}
				if (effects && fires.length >= FIRES_MAX) {
					log = logged(log, run(row.seq, row.at, "refused", "too many runs are waiting"));
				} else if (effects) {
					fires.push({ member, automation: record.id, incarnation: record.incarnation, at: row.at });
					fired = true;
				}
				at = fired ? { ...handled, firedAt: row.at } : handled;
			}
			checkpoints[record.id] = at;
		}
		const next: State = { ...state, automations: checkpoints, queue, log, fires };
		if (canonicalJson(next) === canonicalJson(state)) {
			pump();
			return true;
		}
		const landed = commit(next);
		unsaved = landed ? {} : checkpoints;
		if (landed && queued) deps.onQueued?.();
		pump();
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
	const finish = (fire: Fire, runs: readonly AutomationRun[]): boolean =>
		commit({
			...state,
			fires: state.fires.filter((held) => held.member !== fire.member),
			log: runs.reduce(logged, state.log),
			ran: runs.some((run) => run.outcome === "ran") ? { ...state.ran, [fire.automation]: fire.at } : state.ran,
		});

	/** False when nothing moved. */
	async function runFire(fire: Fire): Promise<boolean> {
		const ports = deps.actions;
		const record = records.get(fire.automation);
		if (!ports || !record || record.incarnation !== fire.incarnation) {
			return finish(fire, [effectRun(fire, "uncertain", "the automation is gone")]);
		}
		// Claimed before any effect.
		const claimed = state.fires.map((held) => (held.member === fire.member ? { ...held, claimed: true } : held));
		if (!commit({ ...state, fires: claimed })) return false;
		const runs: AutomationRun[] = [];
		for (const action of record.body.actions) {
			if (!isEffect(action)) continue;
			const done = await runEffect(action, ports);
			runs.push(effectRun(fire, done.outcome, done.outcome === "ran" ? undefined : done.reason, action.kind));
		}
		return finish(fire, runs);
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
		const lastRanAt = own(state.automations, record.id)?.firedAt ?? own(state.ran, record.id);
		const device = deviceOf(record);
		return {
			id: record.id,
			revision: record.revision,
			automation: record.body,
			sentence: sentenceOf(record.body),
			...(invalid === null ? {} : { invalid }),
			...(lastRanAt === undefined ? {} : { lastRanAt }),
			...(device === undefined ? {} : { device }),
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
			return { written: false, reason: result.reason, ...(result.record ? { record: result.record } : {}) };
		}
		const known = new Set(held.map((record) => record.id));
		forgetRan(verdict.writes.filter((row) => row.op === "remove" || !known.has(row.id)).map((row) => row.id));
		// Bands follow their crossings.
		deps.fields.derivedChanged();
		drain();
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
			};
		},
		ownerRemove(id: string, base: number): ConsoleAutomationDeleteResult {
			const result = write({ kind: "owner_remove", id, base });
			return result.written ? { deleted: true } : { deleted: false, reason: result.reason };
		},
		/** Runs matching event effects. */
		fireEvents(matched: readonly { automation: string; member: string }[], at: number): void {
			const fires = [...state.fires];
			const fired = [...state.fired];
			let log = state.log;
			for (const { automation, member } of matched) {
				const record = records.get(automation);
				if (!record || !armed(record) || !record.body.actions.some(isEffect) || fired.includes(member))
					continue;
				fired.push(member);
				const fire: Fire = { member, automation, incarnation: record.incarnation, at };
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
		/** Field commit callback. */
		drain: (): void => {
			drain();
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
				return [{ id: record.id, trigger, when: tellWhen(record.body) }];
			});
		},
		runs: (): readonly AutomationRun[] => state.log,
		checkpoint: (id: string) => own(state.automations, id) ?? null,
		queued: () => state.queue,
		outbox,
	};
}

export type Automations = ReturnType<typeof createAutomations>;
