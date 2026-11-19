// The automation state file: its shape and its restore.

import { z } from "zod";
import { FIRES_MAX, type Fire, FireSchema } from "./automationFires.js";
import { type AutomationRun, LOG_MAX, RunSchema } from "./automationLog.js";
import { QUEUE_MAX_EVENTS, QueueEntrySchema, type QueueState, retained } from "./automationOutbox.js";
import { NO_SILENCES, type Silences, SilencesSchema } from "./sensorSilence.js";

/** Ids may be prototype keys. */
export const own = <T>(held: Record<string, T>, id: string): T | undefined =>
	Object.hasOwn(held, id) ? held[id] : undefined;
export const FIRED_MAX = 256;

const SlotSchema = z.object({
	revision: z.number().int().positive(),
	incarnation: z.string(),
	/** The last slot handled, or when it was saved. */
	at: z.number(),
	/** Handled before the clock stepped back. */
	skip: z.number().optional(),
});
export type Slot = z.infer<typeof SlotSchema>;

const CheckpointSchema = z.object({
	/** Tracks the record revision. */
	revision: z.number().int().positive(),
	incarnation: z.string(),
	fieldEpoch: z.string(),
	handledSeq: z.number().int().nonnegative(),
	/** The cool-down's clock. */
	firedAt: z.number().optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export interface State {
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
	/** Sensor silences told. */
	silences: Silences;
}

const EMPTY: State = {
	automations: {},
	queue: { lastAt: 0, events: [] },
	log: [],
	ran: {},
	fires: [],
	fired: [],
	slots: {},
	silences: NO_SILENCES,
};

/** Invalid rows drop. */
const LooseStateSchema = z.object({
	automations: z.record(z.string(), z.unknown()).catch({}),
	queue: z.object({ lastAt: z.number().int(), events: z.array(z.unknown()) }).catch(EMPTY.queue),
	log: z.array(z.unknown()).catch([]),
	ran: z.record(z.string(), z.number()).catch({}),
	fires: z.array(z.unknown()).catch([]),
	fired: z.array(z.string()).catch([]),
	slots: z.record(z.string(), z.unknown()).catch({}),
	silences: SilencesSchema.catch(NO_SILENCES),
});

/** A fire of another shape never runs. */
function restoreFires(rows: unknown[], pick: (rows: unknown[], schema: typeof FireSchema) => Fire[]): Fire[] {
	const fires = pick(rows, FireSchema);
	const lost = rows.length - fires.length;
	if (lost > 0) console.warn(`[automations] ${lost} stored runs of another shape were dropped and will not run`);
	return fires.slice(-FIRES_MAX);
}

export function restore(raw: unknown, now: number): State {
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
			events: pick(loose.queue.events, QueueEntrySchema)
				.filter((event) => retained(event, now))
				.slice(-QUEUE_MAX_EVENTS),
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
		silences: loose.silences,
	};
}
