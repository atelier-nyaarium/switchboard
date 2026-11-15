// Queue and checkpoint, atomically.

import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import {
	AUTOMATIONS_MAX,
	type Automation,
	AutomationSchema,
	type EventTrigger,
	TELL_WHEN,
	type TellWhen,
	tellWhen,
} from "../../shared/schemasAutomation.js";
import { createOwnerRecords, type OwnerRecord } from "../ownerRecords.js";
import type { ComputedFields } from "./computedFields.js";

export const AUTOMATION_KIND = "automation";
export const QUEUE_MAX_EVENTS = 256;
export const QUEUE_MAX_BYTES = 64 * 1024;
const LOG_MAX = 64;
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
	/** Absent in an older entry: quietly. */
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
});
export type AutomationRun = z.infer<typeof RunSchema>;

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
}

const EMPTY: State = { automations: {}, queue: { lastAt: 0, events: [] }, log: [] };

/** Invalid log/baseline rows drop. */
const LooseStateSchema = z.object({
	automations: z.record(z.string(), z.unknown()).catch({}),
	queue: z.object({ lastAt: z.number().int(), events: z.array(z.unknown()) }).catch(EMPTY.queue),
	log: z.array(z.unknown()).catch([]),
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
	};
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
}

const queueBytes = (events: readonly QueueEntry[]) => Buffer.byteLength(JSON.stringify(events));

export function createAutomations(deps: AutomationsDeps) {
	let state: State = restore(deps.state.load());

	const records = createOwnerRecords<Automation>({
		store: deps.records,
		kinds: { [AUTOMATION_KIND]: StoredAutomationSchema },
		max: AUTOMATIONS_MAX,
		newIncarnation: deps.newIncarnation,
		refusal: (candidate) => triggerIssue(candidate.body),
		// Remove 2026-11-28 with the legacy body.
		settle: true,
		label: "automations",
	});

	function triggerIssue(body: Automation): string | null {
		if (body.trigger.kind === "event") {
			return deps.eventIssue ? deps.eventIssue(body.trigger) : "this Gateway holds no sources";
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

	/** What the row and its events are called. */
	const sentenceOf = (body: Automation): string => {
		if (body.label !== undefined) return body.label;
		if (body.trigger.kind === "event") return deps.eventSentence?.(body.trigger) ?? `${body.trigger.source} event`;
		const field = deps.fields.get(body.trigger.field)?.body.label ?? body.trigger.field;
		return `${field} becomes ${String(body.trigger.becomes)}`;
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

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && triggerIssue(record.body) === null;

	/** Baselines whose write has not landed. */
	let unsaved: State["automations"] = {};

	/** Replays transitions idempotently. */
	function drain(): boolean {
		const now = deps.now();
		let { queue, log } = state;
		let queued = false;
		const checkpoints: State["automations"] = {};
		for (const record of records.list()) {
			const { trigger } = record.body;
			// The lane runs event triggers.
			if (trigger.kind !== "value" || !armed(record)) continue;
			const { field, becomes } = trigger;
			const saved = state.automations[record.id];
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
				if (!deps.isHome()) {
					log = logged(log, run(row.seq, row.at, "refused", "the assistant does not live on this Gateway"));
					at = handled;
					continue;
				}
				const appendAt = Math.max(now, queue.lastAt + 1);
				const sentence = sentenceOf(record.body);
				const event: QueueEntry = {
					member: `automation:${record.id}:${record.incarnation}:${current.epoch}:${row.seq}`,
					at: appendAt,
					body: {
						title: sentence,
						...(tellWhen(record.body) === "now" ? { when: "now" } : {}),
						fields: {
							automation: sentence,
							field: deps.fields.get(field)?.body.label ?? field,
							value: String(row.value),
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
				at = { ...handled, firedAt: row.at };
				queued = true;
			}
			checkpoints[record.id] = at;
		}
		const next: State = { automations: checkpoints, queue, log };
		if (canonicalJson(next) === canonicalJson(state)) return true;
		const landed = commit(next);
		unsaved = landed ? {} : checkpoints;
		if (landed && queued) deps.onQueued?.();
		return landed;
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

	drain();

	return {
		list: () => records.list(),
		/** Read-time validity; never stored. */
		invalidOf: (id: string): string | null => records.invalidOf(id),
		put(id: string, body: unknown, base: number, options?: { revive?: boolean }) {
			const result = records.put(AUTOMATION_KIND, id, body, base, options);
			if (result.stored) drain();
			return result;
		},
		remove(id: string, base: number) {
			const result = records.remove(id, base);
			if (result.removed) drain();
			return result;
		},
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
		checkpoint: (id: string) => state.automations[id] ?? null,
		queued: () => state.queue,
		outbox,
	};
}

export type Automations = ReturnType<typeof createAutomations>;
