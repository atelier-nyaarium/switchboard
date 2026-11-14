// Stored thresholds drive projections.

import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { type Definition, definitionOf } from "../../shared/device-definitions/index.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import { checkExpression } from "../../shared/expressions.js";
import type {
	DeviceRecord,
	DeviceSensorThreshold,
	DeviceSensorThresholdPutRequest,
} from "../../shared/schemasDevices.js";
import { AUTOMATIONS_MAX, type Automations } from "../computed/automations.js";
import { COMPUTED_FIELDS_MAX, type ComputedFields } from "../computed/computedFields.js";
import { type Threshold, thresholdAutomations, thresholdField, thresholdIds } from "../computed/thresholds.js";

type PutRequest = DeviceSensorThresholdPutRequest;
type ThresholdView = DeviceSensorThreshold;

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

const SnapshotSchema = z.strictObject({
	v: z.literal(1),
	thresholds: z.array(EntrySchema),
	/** Pending row cleanup. */
	unswept: z.array(z.string()),
});
type Snapshot = z.infer<typeof SnapshotSchema>;

interface ThresholdRefusal {
	kind: "refused";
	code: "not_found" | "not_supported" | "stale" | "invalid" | "full" | "write_failed";
	text?: string;
}

export type SensorThresholdPutAnswer = { kind: "ok"; threshold: ThresholdView | null } | ThresholdRefusal;

export interface SensorThresholdsDeps {
	store: Pick<DurableStore, "load" | "saveChecked">;
	fields: ComputedFields;
	automations: Automations;
	/** Readable records only. */
	record: (id: string) => DeviceRecord | null;
	records: () => readonly DeviceRecord[];
	/** Unread rows included. */
	holds: (id: string) => boolean;
}

const banded = (entry: Entry): boolean => entry.low !== undefined || entry.high !== undefined;

const contentOf = (source: { low?: number; high?: number; deadZone: number; coolDownSec: number }) => ({
	...(source.low === undefined ? {} : { low: source.low }),
	...(source.high === undefined ? {} : { high: source.high }),
	deadZone: source.deadZone,
	coolDownSec: source.coolDownSec,
});

const viewOf = (entry: Entry): ThresholdView => ({
	measure: entry.measure,
	...contentOf(entry),
	revision: entry.revision,
});

const numericReadings = (record: DeviceRecord) => {
	if (record.kind !== "sensor" || !record.definition) return [];
	return definitionOf(record.definition)?.readings.filter((reading) => reading.spec.kind === "number") ?? [];
};

const rowPrefix = (device: string) => thresholdIds(device, "").field;

export function createSensorThresholds(deps: SensorThresholdsDeps) {
	const loaded = deps.store.load();
	let snapshot: Snapshot = loaded === null ? { v: 1, thresholds: [], unswept: [] } : SnapshotSchema.parse(loaded);
	/** Projection retries. */
	const dirty = new Set<string>();
	const forgetDue = new Set<string>();

	const write = (next: Snapshot): boolean =>
		commitChecked(
			deps.store,
			next,
			() => {
				snapshot = next;
			},
			{ label: "sensor thresholds" },
		).landed;

	const storedEntryOf = (device: string, measure: string) =>
		snapshot.thresholds.find((entry) => entry.device === device && entry.measure === measure);

	const entryOf = (record: DeviceRecord, reading: Definition["readings"][number]) => {
		const entry = storedEntryOf(record.id, reading.key);
		if (!entry) return undefined;
		const { low, high, ...rest } = entry;
		return {
			...rest,
			...(low !== undefined && reading.alerts?.includes("low") ? { low } : {}),
			...(high !== undefined && reading.alerts?.includes("high") ? { high } : {}),
		};
	};

	const heldRows = (device: string) => {
		const prefix = rowPrefix(device);
		return {
			fields: deps.fields.list().filter((row) => row.id.startsWith(prefix)),
			automations: deps.automations.list().filter((row) => row.id.startsWith(prefix)),
		};
	};

	const desiredOf = (record: DeviceRecord | null) => {
		const fields = new Map<string, unknown>();
		const automations = new Map<string, unknown>();
		if (!record) return { fields, automations };
		for (const reading of numericReadings(record)) {
			const entry = entryOf(record, reading);
			if (!entry || !banded(entry)) continue;
			const threshold: Threshold = {
				device: record.id,
				measure: reading.key,
				label: reading.spec.label,
				...contentOf(entry),
			};
			const ids = thresholdIds(record.id, reading.key);
			const field = thresholdField(threshold);
			if (field) fields.set(ids.field, field);
			const sides = thresholdAutomations(threshold);
			automations.set(ids.low, sides.low);
			automations.set(ids.high, sides.high);
		}
		return { fields, automations };
	};

	const reconcile = (device: string): boolean => {
		const record = deps.record(device);
		const unswept = snapshot.unswept.includes(device);
		// Preserve unread rows.
		if (!record && !unswept) return true;
		const desired = desiredOf(record);
		const held = heldRows(device);
		let ok = true;
		for (const row of held.automations) {
			if (!desired.automations.has(row.id)) ok = deps.automations.remove(row.id, row.revision).removed && ok;
		}
		for (const row of held.fields) {
			if (!desired.fields.has(row.id)) ok = deps.fields.remove(row.id, row.revision).removed && ok;
		}
		for (const [id, body] of desired.fields) {
			const current = held.fields.find((row) => row.id === id);
			if (current && canonicalJson(current.body) === canonicalJson(body)) continue;
			ok = deps.fields.put(id, body, current?.revision ?? 0, { revive: true }).stored && ok;
		}
		for (const [id, body] of desired.automations) {
			const current = held.automations.find((row) => row.id === id);
			if (current && canonicalJson(current.body) === canonicalJson(body)) continue;
			ok = deps.automations.put(id, body, current?.revision ?? 0, { revive: true }).stored && ok;
		}
		if (ok && unswept) write({ ...snapshot, unswept: snapshot.unswept.filter((id) => id !== device) });
		if (ok) dirty.delete(device);
		else dirty.add(device);
		return ok;
	};

	const read = (record: DeviceRecord): ThresholdView[] =>
		numericReadings(record).flatMap((reading) => {
			const entry = entryOf(record, reading);
			return entry && banded(entry) ? [viewOf(entry)] : [];
		});

	const roomFor = (device: string, measure: string): ThresholdRefusal | null => {
		const ids = thresholdIds(device, measure);
		const fieldIds = new Set(deps.fields.list().map((row) => row.id));
		const automationIds = new Set(deps.automations.list().map((row) => row.id));
		if (!fieldIds.has(ids.field) && fieldIds.size + 1 > COMPUTED_FIELDS_MAX)
			return { kind: "refused", code: "full", text: "this Gateway holds too many fields" };
		const needed = [ids.low, ids.high].filter((id) => !automationIds.has(id)).length;
		if (automationIds.size + needed > AUTOMATIONS_MAX)
			return { kind: "refused", code: "full", text: "this Gateway holds too many automations" };
		return null;
	};

	const put = (record: DeviceRecord, op: PutRequest): SensorThresholdPutAnswer => {
		if (record.kind !== "sensor") return { kind: "refused", code: "not_supported" };
		if (!record.definition) return { kind: "refused", code: "not_supported", text: "the sensor has no definition" };
		const reading = numericReadings(record).find((entry) => entry.key === op.measure);
		if (!reading)
			return { kind: "refused", code: "invalid", text: "the definition does not read this numeric measure" };
		if (
			(op.low !== undefined && !reading.alerts?.includes("low")) ||
			(op.high !== undefined && !reading.alerts?.includes("high"))
		)
			return { kind: "refused", code: "invalid", text: "the definition does not offer that alert side" };
		const stored = storedEntryOf(record.id, op.measure);
		const held = entryOf(record, reading);
		const hidden =
			stored !== undefined &&
			held !== undefined &&
			canonicalJson(contentOf(stored)) !== canonicalJson(contentOf(held));
		const content = contentOf(op);
		const clearing = content.low === undefined && content.high === undefined;
		if (held && banded(held)) {
			const echoes = op.revision === held.revision || op.revision === held.revision - 1 || op.revision === 0;
			if (echoes && stored && canonicalJson(contentOf(stored)) === canonicalJson(content))
				return { kind: "ok", threshold: viewOf(held) };
			if (op.revision !== held.revision) return { kind: "refused", code: "stale" };
		} else {
			if (clearing && !hidden) return { kind: "ok", threshold: null };
			if (op.revision !== 0 && op.revision !== held?.revision) return { kind: "refused", code: "stale" };
		}
		if (!clearing) {
			const band = checkExpression(
				[
					{ kind: "unknown", reason: "sensor threshold input" },
					{
						kind: "band",
						input: 0,
						...(content.low === undefined ? {} : { low: content.low }),
						...(content.high === undefined ? {} : { high: content.high }),
						deadZone: content.deadZone,
					},
				],
				() => null,
			);
			if (!band.ok) return { kind: "refused", code: "invalid", text: band.issue.message };
			const full = roomFor(record.id, op.measure);
			if (full) return full;
		}
		const entry: Entry = {
			device: record.id,
			measure: op.measure,
			...content,
			revision: (held?.revision ?? 0) + 1,
		};
		const others = snapshot.thresholds.filter((item) => item !== stored);
		if (!write({ ...snapshot, thresholds: [...others, entry] })) return { kind: "refused", code: "write_failed" };
		reconcile(record.id);
		return { kind: "ok", threshold: clearing ? null : viewOf(entry) };
	};

	const forget = (device: string): boolean => {
		const owned = snapshot.thresholds.some((entry) => entry.device === device);
		const rows = heldRows(device);
		if (!owned && rows.fields.length === 0 && rows.automations.length === 0) {
			forgetDue.delete(device);
			return true;
		}
		const unswept = snapshot.unswept.includes(device) ? snapshot.unswept : [...snapshot.unswept, device];
		if (!write({ v: 1, thresholds: snapshot.thresholds.filter((entry) => entry.device !== device), unswept })) {
			forgetDue.add(device);
			return false;
		}
		forgetDue.delete(device);
		reconcile(device);
		return true;
	};

	/** Rebuilds projections. */
	const start = (): void => {
		for (const device of new Set(snapshot.thresholds.map((entry) => entry.device))) {
			if (!deps.holds(device)) forget(device);
		}
		const devices = new Set([...deps.records().map((record) => record.id), ...snapshot.unswept]);
		for (const device of devices) reconcile(device);
	};

	/** Retries failed projections. */
	const tick = (): void => {
		for (const device of [...forgetDue]) forget(device);
		for (const device of [...dirty]) reconcile(device);
	};

	return { read, put, forget, start, tick };
}

export type SensorThresholds = ReturnType<typeof createSensorThresholds>;
