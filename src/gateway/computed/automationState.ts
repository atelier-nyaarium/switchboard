// The automation state file: its shape and its restore.

import { z } from "zod";
import { type Automation, AutomationSchema } from "../../shared/schemasAutomation.js";
import { type AutomationFunction, FunctionSchema } from "../../shared/schemasFunction.js";
import { FIRES_MAX, type Fire, readFire } from "./automationFires.js";
import { fireRow, LOG_MAX, logged, type RunRow, RunRowSchema } from "./automationLog.js";
import { QUEUE_MAX_EVENTS, QueueEntrySchema, type QueueState, retained } from "./automationOutbox.js";
import { clamped, NATURES } from "./automationSteps.js";
import { NO_SILENCES, type Silences, SilencesSchema } from "./sensorSilence.js";

/** Ids may be prototype keys. */
export const own = <T>(held: Record<string, T>, id: string): T | undefined =>
	Object.hasOwn(held, id) ? held[id] : undefined;
export const FIRED_MAX = 256;
const STORED_UNREAD = "a run stored in a shape this build cannot read";

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
	log: RunRow[];
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
	/** Each body a held fire fired with, by `versionKey`. */
	versions: Record<string, Automation>;
	/** By `frameKey`. */
	functionVersions: Record<string, AutomationFunction>;
	/** Unused since. */
	unusedFunctions: Record<string, number>;
	/** The newest set landed, per switch. */
	landedSets: Record<string, LandedSwitch>;
	/** A call's cool-down clock, set at admission. */
	firedAt: Record<string, number>;
}

const LandedSwitchSchema = z.strictObject({
	member: z.string(),
	at: z.number().int(),
	nature: z.enum(NATURES),
});
export type LandedSwitch = z.infer<typeof LandedSwitchSchema>;

/** An automation body as one revision of one incarnation. */
export const versionKey = (fire: { automation: string; incarnation: string; revision: number }): string =>
	`${fire.automation}:${fire.incarnation}:${fire.revision}`;

const EMPTY: State = {
	automations: {},
	queue: { lastAt: 0, events: [] },
	log: [],
	ran: {},
	fires: [],
	fired: [],
	slots: {},
	silences: NO_SILENCES,
	versions: {},
	functionVersions: {},
	unusedFunctions: {},
	landedSets: {},
	firedAt: {},
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
	versions: z.record(z.string(), z.unknown()).catch({}),
	functionVersions: z.record(z.string(), z.unknown()).catch({}),
	unusedFunctions: z.record(z.string(), z.number()).catch({}),
	landedSets: z.record(z.string(), z.unknown()).catch({}),
	firedAt: z.record(z.string(), z.number()).catch({}),
});

/** Without an automation id, no row. */
const DroppedFireSchema = z.object({
	automation: z.string().min(1),
	seq: z.number().int().catch(0),
	at: z.number().int().catch(0),
});

/** A fire of another shape never runs, and logs once. */
function restoreFires(rows: unknown[], now: number): { fires: Fire[]; dropped: RunRow[]; lost: number } {
	const fires: Fire[] = [];
	const dropped: RunRow[] = [];
	let lost = 0;
	for (const row of rows) {
		const fire = readFire(row);
		if (fire) {
			const steps = Object.fromEntries(
				Object.entries(fire.steps).map(([path, step]) => [path, clamped(step, now)]),
			);
			fires.push({ ...fire, steps });
			continue;
		}
		lost++;
		const named = DroppedFireSchema.safeParse(row);
		if (named.success) dropped.push(fireRow(named.data, "uncertain", STORED_UNREAD));
	}
	if (lost > 0) console.warn(`[automations] ${lost} stored runs of another shape were dropped and will not run`);
	return { fires: fires.slice(-FIRES_MAX), dropped, lost };
}

const readable = <T>(rows: Record<string, unknown>, schema: z.ZodType<T>): Record<string, T> =>
	Object.fromEntries(
		Object.entries(rows).flatMap(([key, row]) => {
			const parsed = schema.safeParse(row);
			return parsed.success ? [[key, parsed.data]] : [];
		}),
	);

/** `changed`: the first write must land it. */
export function restore(raw: unknown, now: number): { state: State; changed: boolean } {
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
	const { fires, dropped, lost } = restoreFires(loose.fires, now);
	const state: State = {
		automations,
		queue: {
			lastAt: loose.queue.lastAt,
			events: pick(loose.queue.events, QueueEntrySchema)
				.filter((event) => retained(event, now))
				.slice(-QUEUE_MAX_EVENTS),
		},
		log: dropped.reduce(logged, pick(loose.log, RunRowSchema)).slice(-LOG_MAX),
		ran,
		fires,
		fired: loose.fired.slice(-FIRED_MAX),
		slots: Object.fromEntries(
			Object.entries(loose.slots).flatMap(([id, row]) => {
				const parsed = SlotSchema.safeParse(row);
				return parsed.success ? [[id, parsed.data]] : [];
			}),
		),
		silences: loose.silences,
		// An unreadable one leaves its fires unpinned.
		versions: readable(loose.versions, AutomationSchema),
		functionVersions: readable(loose.functionVersions, FunctionSchema),
		unusedFunctions: loose.unusedFunctions,
		landedSets: readable(loose.landedSets, LandedSwitchSchema),
		firedAt: loose.firedAt,
	};
	return { state, changed: lost > 0 };
}
