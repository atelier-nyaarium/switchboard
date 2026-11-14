// Last advert; 24-hour extremes.

import { z } from "zod";
import type { Advert } from "../../shared/ble-recognition.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_HOURS = 24;
export const PAYLOADS_MAX = 4;

const AdvertSchema = z.object({
	name: z.string().max(64).optional(),
	data: z.record(z.string(), z.string()),
	services: z.array(z.string()).max(64),
});

const BucketSchema = z.object({
	hour: z.number().int().nonnegative(),
	min: z.number(),
	minAt: z.number().int().nonnegative(),
	max: z.number(),
	maxAt: z.number().int().nonnegative(),
});
type Bucket = z.infer<typeof BucketSchema>;

const DeviceRowSchema = z.object({
	heard: z.object({ advert: AdvertSchema, at: z.number().int().nonnegative() }).optional(),
	buckets: z.record(z.string(), z.array(BucketSchema).max(DAY_HOURS + 1)),
});
type DeviceRow = z.infer<typeof DeviceRowSchema>;

export interface Heard {
	advert: Advert;
	at: number;
}

export interface Extremes {
	low?: { value: number; at: number };
	high?: { value: number; at: number };
}

export interface ReadingsHoldDeps {
	store: Pick<DurableStore, "load" | "saveChecked">;
	now: () => number;
}

/** Skip invalid rows. */
function restore(raw: unknown, now: number): Map<string, DeviceRow> {
	const rows = new Map<string, DeviceRow>();
	if (typeof raw !== "object" || raw === null) return rows;
	for (const [mac, row] of Object.entries(raw)) {
		const parsed = DeviceRowSchema.safeParse(row);
		if (!parsed.success) continue;
		// Future timestamps freeze readings.
		if (parsed.data.heard && parsed.data.heard.at > now) delete parsed.data.heard;
		rows.set(mac, parsed.data);
	}
	return rows;
}

/** Newest capture wins. */
export function createReadingsHold(deps: ReadingsHoldDeps) {
	const rows = restore(deps.store.load(), deps.now());
	const payloads = new Map<string, Heard[]>();
	let dirty = false;

	const rowOf = (mac: string): DeviceRow => {
		const held = rows.get(mac);
		if (held) return held;
		const fresh: DeviceRow = { buckets: {} };
		rows.set(mac, fresh);
		return fresh;
	};

	/** False for late captures. */
	const ingest = (mac: string, advert: Advert, at: number): boolean => {
		const row = rowOf(mac);
		if (row.heard && row.heard.at > at) return false;
		row.heard = { advert: { ...advert, data: { ...advert.data }, services: [...advert.services] }, at };
		dirty = true;
		const seen = payloads.get(mac) ?? [];
		const key = canonicalJson(advert.data);
		if (canonicalJson(seen.at(-1)?.advert.data ?? null) !== key) {
			payloads.set(mac, [...seen, { advert, at }].slice(-PAYLOADS_MAX));
		}
		return true;
	};

	const record = (mac: string, measure: string, value: number, at: number): void => {
		const row = rowOf(mac);
		const hour = Math.floor(at / HOUR_MS);
		const buckets = row.buckets[measure] ?? [];
		const last = buckets.at(-1);
		let next: Bucket[];
		if (last && last.hour === hour) {
			const bucket = { ...last };
			if (value < bucket.min) Object.assign(bucket, { min: value, minAt: at });
			if (value > bucket.max) Object.assign(bucket, { max: value, maxAt: at });
			next = [...buckets.slice(0, -1), bucket];
		} else {
			next = [...buckets, { hour, min: value, minAt: at, max: value, maxAt: at }];
		}
		row.buckets[measure] = next.filter((bucket) => bucket.hour > hour - DAY_HOURS);
		dirty = true;
	};

	const extremes = (mac: string, measure: string): Extremes => {
		const since = Math.floor(deps.now() / HOUR_MS) - DAY_HOURS;
		const buckets = (rows.get(mac)?.buckets[measure] ?? []).filter((bucket) => bucket.hour > since);
		if (buckets.length === 0) return {};
		const low = buckets.reduce((best, bucket) => (bucket.min < best.min ? bucket : best));
		const high = buckets.reduce((best, bucket) => (bucket.max > best.max ? bucket : best));
		return { low: { value: low.min, at: low.minAt }, high: { value: high.max, at: high.maxAt } };
	};

	const flush = (): boolean => {
		if (!dirty) return true;
		const since = Math.floor(deps.now() / HOUR_MS) - DAY_HOURS;
		for (const row of rows.values()) {
			for (const [measure, buckets] of Object.entries(row.buckets)) {
				const kept = buckets.filter((bucket) => bucket.hour > since);
				if (kept.length === 0) delete row.buckets[measure];
				else row.buckets[measure] = kept;
			}
		}
		const landed = commitChecked(
			deps.store,
			Object.fromEntries(rows),
			() => {
				dirty = false;
			},
			{ label: "sensor readings" },
		).landed;
		return landed;
	};

	const keepOnly = (macs: ReadonlySet<string>): void => {
		for (const mac of [...rows.keys()]) if (!macs.has(mac)) forget(mac);
	};

	const forget = (mac: string): void => {
		if (rows.delete(mac)) dirty = true;
		payloads.delete(mac);
	};

	return {
		ingest,
		record,
		latest: (mac: string): Heard | null => rows.get(mac)?.heard ?? null,
		/** Oldest first. */
		payloads: (mac: string): readonly Heard[] => payloads.get(mac) ?? [],
		extremes,
		flush,
		forget,
		keepOnly,
	};
}

export type ReadingsHold = ReturnType<typeof createReadingsHold>;
