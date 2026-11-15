// Remove 2027-01-15: sensor thresholds stored before automations held them.

import { z } from "zod";
import { definitionOf } from "../../shared/device-definitions/index.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import type { Automation, CrossingDirection } from "../../shared/schemasAutomation.js";
import type { DeviceRecord } from "../../shared/schemasDevices.js";
import type { Automations } from "../computed/automations.js";
import type { ComputedFields } from "../computed/computedFields.js";

const EntrySchema = z.strictObject({
	device: z.string(),
	measure: z.string(),
	low: z.number().optional(),
	high: z.number().optional(),
	deadZone: z.number(),
	coolDownSec: z.number(),
	revision: z.number().int().positive(),
});
type Entry = z.infer<typeof EntrySchema>;

/** Read, never written: a build before this finds it as it left it. */
const StoredSchema = z.strictObject({
	v: z.literal(1),
	thresholds: z.array(EntrySchema),
	/** Sensors removed with rows still held. */
	unswept: z.array(z.string()),
});

type Stored = z.infer<typeof StoredSchema>;

const MarkSchema = z.strictObject({ v: z.literal(1), converted: z.array(z.string()) });
type Mark = z.infer<typeof MarkSchema>;

const SIDES = { low: "below", high: "above" } as const satisfies Record<string, CrossingDirection>;
type Side = keyof typeof SIDES;

/** Ids a stored alert held, by its sensor. */
export const alertPrefix = (device: string): string => `threshold-${device.replaceAll(":", "")}-`;

export const alertId = (device: string, measure: string, side: Side): string =>
	`${alertPrefix(device)}${measure}-${side}`;

export interface ThresholdConversionDeps {
	stored: Pick<DurableStore, "load">;
	mark: Pick<DurableStore, "load" | "saveChecked">;
	fields: Pick<ComputedFields, "list" | "remove">;
	automations: Pick<Automations, "list" | "write">;
	/** Readable records only. */
	record: (id: string) => DeviceRecord | null;
	/** Unread rows included. */
	holds: (id: string) => boolean;
}

const crossing = (entry: Entry, side: Side, threshold: number): Automation => ({
	enabled: true,
	trigger: {
		kind: "crossing",
		device: entry.device,
		measure: entry.measure,
		direction: SIDES[side],
		threshold,
		deadZone: entry.deadZone,
		coolDownSec: entry.coolDownSec,
	},
	actions: [{ kind: "tell_assistant", when: "quietly" }],
});

/** One crossing per side its definition offers. */
function alertsOf(record: DeviceRecord, entries: readonly Entry[]): Map<string, Automation> {
	const rows = new Map<string, Automation>();
	if (record.kind !== "sensor" || !record.definition) return rows;
	for (const reading of definitionOf(record.definition)?.readings ?? []) {
		if (reading.spec.kind !== "number") continue;
		const entry = entries.find((held) => held.device === record.id && held.measure === reading.key);
		if (!entry) continue;
		for (const side of ["low", "high"] as const) {
			const threshold = entry[side];
			if (threshold === undefined || !reading.alerts?.includes(side)) continue;
			rows.set(alertId(record.id, reading.key, side), crossing(entry, side, threshold));
		}
	}
	return rows;
}

/** Each sensor's stored alerts become plain automations, once. */
export function createThresholdConversion(deps: ThresholdConversionDeps) {
	const held = deps.stored.load();
	const stored: Stored = held === null ? { v: 1, thresholds: [], unswept: [] } : StoredSchema.parse(held);
	const marked = deps.mark.load();
	let mark: Mark = marked === null ? { v: 1, converted: [] } : MarkSchema.parse(marked);
	const refused = new Set<string>();

	const pending = (): string[] =>
		[...new Set([...stored.thresholds.map((entry) => entry.device), ...stored.unswept])].filter(
			(device) => !mark.converted.includes(device),
		);

	const done = (device: string): boolean => {
		const next: Mark = { v: 1, converted: [...mark.converted, device] };
		return commitChecked(
			deps.mark,
			next,
			() => {
				mark = next;
			},
			{ label: "sensor thresholds converted" },
		).landed;
	};

	const convert = (device: string): boolean => {
		const record = deps.record(device);
		const gone = !deps.holds(device) || stored.unswept.includes(device);
		// An unread sensor keeps its rows.
		if (!record && !gone) return done(device);
		const prefix = alertPrefix(device);
		const rows = record ? alertsOf(record, stored.thresholds) : new Map<string, Automation>();
		const written = deps.automations.write({ kind: "conversion", prefix, rows });
		if (!written.written) {
			if (!refused.has(device))
				console.warn(`[devices] ${device}'s alerts were not converted: ${written.reason}`);
			refused.add(device);
			return false;
		}
		refused.delete(device);
		// A band another automation still watches stays.
		const watched = new Set(
			deps.automations.list().flatMap(({ body }) => (body.trigger.kind === "value" ? [body.trigger.field] : [])),
		);
		const bands = deps.fields.list().filter((row) => row.id.startsWith(prefix) && !watched.has(row.id));
		if (!bands.every((row) => deps.fields.remove(row.id, row.revision).removed)) return false;
		return done(device);
	};

	/** Retried until every sensor landed. */
	const run = (): void => {
		for (const device of pending()) convert(device);
	};

	return { run, pending };
}

export type ThresholdConversion = ReturnType<typeof createThresholdConversion>;
