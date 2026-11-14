// Queue and checkpoint, atomically.

import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import { RULE_ID_RE } from "../../shared/schemasAssistantRules.js";
import type { ListPage, ListQuery, PollAnswer, Watcher, WatcherEvent } from "../assistant/watcher.js";
import { createOwnerRecords, type OwnerRecord } from "../ownerRecords.js";
import type { ComputedFields } from "./computedFields.js";

export const AUTOMATIONS_MAX = 64;
export const AUTOMATION_KIND = "automation";
export const QUEUE_MAX_EVENTS = 256;
export const QUEUE_MAX_BYTES = 64 * 1024;
const LOG_MAX = 64;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_POLL_MS = 10 * 60 * 1000;
export const SENSORS_WATCHER_ID = "sensors";

export const AutomationSchema = z.strictObject({
	label: z.string().min(1).max(80),
	enabled: z.boolean(),
	trigger: z.strictObject({
		field: z.string().regex(RULE_ID_RE),
		becomes: z.union([z.string().min(1).max(256), z.boolean()]),
	}),
	action: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("tell_assistant") })]),
	coolDownSec: z.number().int().min(0).max(86_400),
});
export type Automation = z.infer<typeof AutomationSchema>;

/** Unreadable bodies stay queued. */
const QueueEntrySchema = z.strictObject({ member: z.string(), at: z.number().int(), body: z.unknown() });
type QueueEntry = z.infer<typeof QueueEntrySchema>;
const EventBodySchema = z.strictObject({ title: z.string(), fields: z.record(z.string(), z.string()) });

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
		queue: { lastAt: loose.queue.lastAt, events: pick(loose.queue.events, QueueEntrySchema) },
		log: pick(loose.log, RunSchema),
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
}

const queueBytes = (events: readonly QueueEntry[]) => Buffer.byteLength(JSON.stringify(events));

export function createAutomations(deps: AutomationsDeps) {
	let state: State = restore(deps.state.load());

	const records = createOwnerRecords<Automation>({
		store: deps.records,
		kinds: { [AUTOMATION_KIND]: AutomationSchema },
		max: AUTOMATIONS_MAX,
		newIncarnation: deps.newIncarnation,
		refusal: (candidate) => triggerIssue(candidate.body),
		label: "automations",
	});

	function triggerIssue(body: Automation): string | null {
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
			if (!armed(record)) continue;
			const { field, becomes } = record.body.trigger;
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
				if (at.firedAt !== undefined && row.at - at.firedAt < record.body.coolDownSec * 1000) {
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
				const event: QueueEntry = {
					member: `automation:${record.id}:${record.incarnation}:${current.epoch}:${row.seq}`,
					at: appendAt,
					body: {
						title: record.body.label,
						fields: {
							automation: record.body.label,
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

	/** Unreadable entries stay hidden. */
	const watcherEvents = (events: readonly QueueEntry[]): WatcherEvent[] =>
		events.flatMap((event) => {
			const body = EventBodySchema.safeParse(event.body);
			return body.success ? [{ id: event.member, at: event.at, ...body.data }] : [];
		});

	const watcher: Watcher = {
		id: SENSORS_WATCHER_ID,
		label: "Sensors",
		fieldSpecs: [
			{ kind: "text", field: "automation", label: "Automation" },
			{ kind: "text", field: "field", label: "Field" },
			{ kind: "text", field: "value", label: "Value" },
		],
		async poll(cursor): Promise<PollAnswer> {
			const { lastAt, events } = state.queue;
			if (cursor === String(lastAt)) return { kind: "unchanged", nextPollMs: FALLBACK_POLL_MS };
			return {
				kind: "events",
				events: watcherEvents(events),
				cursor: String(lastAt),
				capped: false,
				nextPollMs: FALLBACK_POLL_MS,
			};
		},
		async list(query: ListQuery): Promise<ListPage> {
			const since = query.scope === "new" ? (query.since ?? 0) : -1;
			const shown = watcherEvents(state.queue.events.filter((event) => event.at > since)).reverse();
			return { events: shown, here: "p0", ...(query.scope === "new" ? { mark: state.queue.lastAt } : {}) };
		},
	};

	drain();

	return {
		list: () => records.list(),
		/** Read-time validity; never stored. */
		invalidOf: (id: string): string | null => records.invalidOf(id),
		put(id: string, body: unknown, base: number) {
			const result = records.put(AUTOMATION_KIND, id, body, base);
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
		runs: (): readonly AutomationRun[] => state.log,
		watcher,
	};
}

export type Automations = ReturnType<typeof createAutomations>;
