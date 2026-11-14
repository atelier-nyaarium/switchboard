import { describe, expect, it } from "vitest";
import { createReadingsHold, PAYLOADS_MAX } from "../gateway/devices/readingsHold.js";

const HOUR = 60 * 60 * 1000;
const FREEZER = "ce:1c:44:06:3c:5d";
const advert = (hex: string) => ({ data: { "1": hex }, services: ["ec88"] });

function world(start = 100 * HOUR) {
	let saved: unknown = null;
	let clock = start;
	let failing = false;
	const store = {
		load: () => saved,
		saveChecked: (value: unknown) => {
			if (failing) throw new Error("disk full");
			saved = structuredClone(value);
		},
	};
	const open = () => createReadingsHold({ store, now: () => clock });
	return {
		open,
		at: (ms: number) => {
			clock = ms;
		},
		fail: (on: boolean) => {
			failing = on;
		},
	};
}

describe("readings hold", () => {
	it("keeps the newest capture, ignoring one that arrives late, and the last distinct payloads", () => {
		const hold = world().open();
		expect(hold.ingest(FREEZER, advert("010103bac864"), 2_000, "gateway")).toBe(true);
		expect(hold.ingest(FREEZER, advert("010180d16c5a"), 1_000, "phones")).toBe(false);
		hold.ingest(FREEZER, advert("010103bac864"), 3_000, "phones");
		for (let i = 0; i < PAYLOADS_MAX + 2; i++)
			hold.ingest(FREEZER, advert(`0101${i}0`), 4_000 + i, i % 2 === 0 ? "gateway" : "phones");

		expect(hold.latest(FREEZER)?.at).toBe(4_000 + PAYLOADS_MAX + 1);
		expect(hold.payloads(FREEZER)).toHaveLength(PAYLOADS_MAX);
		expect(new Set(hold.payloads(FREEZER).map((heard) => heard.advert.data["1"])).size).toBe(PAYLOADS_MAX);
		expect(hold.payloads(FREEZER).map(({ at, radio }) => ({ at, radio }))).toEqual([
			{ at: 4_000 + PAYLOADS_MAX + 1, radio: "phones" },
			{ at: 4_000 + PAYLOADS_MAX, radio: "gateway" },
			{ at: 4_000 + PAYLOADS_MAX - 1, radio: "phones" },
			{ at: 4_000 + PAYLOADS_MAX - 2, radio: "gateway" },
		]);
	});

	it("answers the 24-hour low and high across hourly buckets, dropping what aged out", () => {
		const w = world();
		const hold = w.open();
		const base = 100 * HOUR;
		hold.record(FREEZER, "temperature", -18, base);
		hold.record(FREEZER, "temperature", -21, base + 10 * 60 * 1000);
		hold.record(FREEZER, "temperature", -15, base + 5 * HOUR);
		w.at(base + 6 * HOUR);

		expect(hold.extremes(FREEZER, "temperature")).toEqual({
			low: { value: -21, at: base + 10 * 60 * 1000 },
			high: { value: -15, at: base + 5 * HOUR },
		});
		w.at(base + 25 * HOUR);
		expect(hold.extremes(FREEZER, "temperature")).toEqual({
			high: { value: -15, at: base + 5 * HOUR },
			low: { value: -15, at: base + 5 * HOUR },
		});
		w.at(base + 30 * HOUR);
		expect(hold.extremes(FREEZER, "temperature")).toEqual({});
	});

	it("persists on flush, keeps memory when the write fails, and restores across a reopen", () => {
		const w = world();
		const hold = w.open();
		hold.ingest(FREEZER, advert("010103bac864"), 100 * HOUR, "gateway");
		hold.record(FREEZER, "temperature", 24.4, 100 * HOUR);
		w.fail(true);
		expect(hold.flush()).toBe(false);
		expect(hold.latest(FREEZER)?.at).toBe(100 * HOUR);
		w.fail(false);
		expect(hold.flush()).toBe(true);

		const reopened = w.open();
		expect(reopened.latest(FREEZER)?.advert.data["1"]).toBe("010103bac864");
		expect(reopened.extremes(FREEZER, "temperature").high?.value).toBe(24.4);
		expect(reopened.payloads(FREEZER)).toEqual([]);
	});
});
