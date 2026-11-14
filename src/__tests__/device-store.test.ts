import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDeviceStore } from "../gateway/devices/store.js";
import { DEVICE_MAX_RECORDS, type DeviceRecord } from "../shared/schemasDevices.js";
import { REVISION_CEILING } from "../shared/schemasRunbook.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const fresh = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "device-store-"));
	roots.push(root);
	return root;
};

const device = (id: string, over: Partial<DeviceRecord> = {}): DeviceRecord => ({
	id,
	name: id,
	kind: "switch",
	driver: "kasa",
	address: "192.168.1.10",
	revision: 1,
	...over,
});

const addRequest = (mac: string, over: { address?: string; name?: string } = {}) => ({
	mac,
	address: over.address ?? "192.168.1.10",
	name: over.name ?? "Lamp",
});

describe("device store", () => {
	it("adds and lists a record with a Gateway revision", () => {
		const changed: string[] = [];
		const store = openDeviceStore(fresh(), { onChanged: (id) => changed.push(id) });

		expect(store.add(addRequest("aa:bb:cc:dd:ee:ff"))).toMatchObject({
			stored: true,
			record: { id: "aa:bb:cc:dd:ee:ff", name: "Lamp", revision: 1 },
		});
		expect(store.list()).toMatchObject({
			revision: 1,
			records: [{ id: "aa:bb:cc:dd:ee:ff", address: "192.168.1.10" }],
		});
		expect(changed).toEqual(["aa:bb:cc:dd:ee:ff"]);

		expect(store.add(addRequest("aa:bb:cc:dd:ee:ff"))).toMatchObject({ stored: true, record: { revision: 1 } });
		expect(store.add(addRequest("aa:bb:cc:dd:ee:ff", { name: "Fan" }))).toMatchObject({
			stored: false,
			record: { name: "Lamp" },
		});
		expect(store.list().revision).toBe(1);
	});

	it("returns the held record for a stale rename and removal", () => {
		const store = openDeviceStore(fresh());
		store.add(addRequest("aa:bb:cc:dd:ee:ff", { name: "Lamp" }));
		expect(store.rename("aa:bb:cc:dd:ee:ff", "Desk lamp", 1)).toMatchObject({
			stored: true,
			record: { revision: 2 },
		});
		expect(store.rename("aa:bb:cc:dd:ee:ff", "Desk lamp", 1)).toMatchObject({
			stored: true,
			record: { revision: 2 },
		});

		expect(store.rename("aa:bb:cc:dd:ee:ff", "Old name", 1)).toMatchObject({
			stored: false,
			record: { name: "Desk lamp", revision: 2 },
		});
		expect(store.remove("aa:bb:cc:dd:ee:ff", 1)).toMatchObject({
			deleted: false,
			record: { name: "Desk lamp", revision: 2 },
		});
		expect(store.remove("aa:bb:cc:dd:ee:ff", 2)).toEqual({ deleted: true });
		expect(store.list().records).toEqual([]);
	});

	it("keeps a removed MAC revision across a reopen", () => {
		const dataDir = fresh();
		const store = openDeviceStore(dataDir);
		store.add(addRequest("aa:bb:cc:dd:ee:ff"));
		expect(store.remove("aa:bb:cc:dd:ee:ff", 1)).toEqual({ deleted: true });
		expect(store.remove("aa:bb:cc:dd:ee:ff", 1)).toEqual({ deleted: true });
		expect(store.remove("aa:bb:cc:dd:ee:ff", 2)).toMatchObject({ deleted: false });

		const reopened = openDeviceStore(dataDir);
		expect(reopened.remove("aa:bb:cc:dd:ee:ff", 1)).toEqual({ deleted: true });
		expect(reopened.add(addRequest("aa:bb:cc:dd:ee:ff", { name: "Readded" }))).toMatchObject({
			stored: true,
			record: { revision: 2 },
		});
		expect(reopened.rename("aa:bb:cc:dd:ee:ff", "Stale rename", 1)).toMatchObject({
			stored: false,
			record: { name: "Readded", revision: 2 },
		});
		expect(reopened.remove("aa:bb:cc:dd:ee:ff", 1)).toMatchObject({
			deleted: false,
			record: { revision: 2 },
		});
	});

	it("moves revisions only when a scan changes the address", () => {
		const store = openDeviceStore(fresh());
		store.add(addRequest("aa:bb:cc:dd:ee:ff"));

		expect(store.refreshAddress("aa:bb:cc:dd:ee:ff", "192.168.1.10")).toMatchObject({
			changed: false,
			record: { revision: 1 },
		});
		expect(store.list().revision).toBe(1);
		expect(store.refreshAddress("aa:bb:cc:dd:ee:ff", "192.168.1.11")).toMatchObject({
			changed: true,
			record: { address: "192.168.1.11", revision: 2 },
		});
		expect(store.list().revision).toBe(2);
	});

	it("refuses a poisoned file whole and heals it on the next write", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const dataDir = fresh();
		const file = path.join(dataDir, "devices.json");
		const valid = device("aa:bb:cc:dd:ee:ff");
		const poisoned: unknown[] = [
			{ revision: REVISION_CEILING + 1, records: [] },
			{ revision: 1, records: [valid, valid] },
			{ revision: 1, records: [device("AA:BB:CC:DD:EE:FF")] },
			{ revision: 1, records: [{ ...valid, id: undefined }] },
			{ revision: 0, records: [valid] },
			{
				revision: DEVICE_MAX_RECORDS + 1,
				records: Array.from({ length: DEVICE_MAX_RECORDS + 1 }, (_, i) =>
					device(`aa:bb:cc:dd:ee:${i.toString(16).padStart(2, "0")}`),
				),
			},
		];

		for (const snapshot of poisoned) {
			fs.writeFileSync(file, JSON.stringify(snapshot));
			const store = openDeviceStore(dataDir);
			expect(store.list()).toEqual({ records: [], revision: 0 });
			expect(store.add(addRequest("bb:bb:cc:dd:ee:ff"))).toMatchObject({ stored: true });
			expect(
				openDeviceStore(dataDir)
					.list()
					.records.map((record) => record.id),
			).toEqual(["bb:bb:cc:dd:ee:ff"]);
		}
	});

	it("holds a row a newer build wrote: reserves its id and its place, refuses its edits, and writes it back", () => {
		const dataDir = fresh();
		const file = path.join(dataDir, "devices.json");
		const sensor = {
			id: "ce:1c:44:06:3c:5d",
			name: "Porch light",
			kind: "light",
			driver: "lifx",
			address: "192.168.1.30",
			revision: 2,
		};
		const lamp = device("aa:bb:cc:dd:ee:ff", { name: "Lamp" });
		fs.writeFileSync(file, JSON.stringify({ revision: 2, records: [lamp, sensor] }));
		const store = openDeviceStore(dataDir);

		expect(store.list().records.map((record) => record.id)).toEqual([lamp.id]);
		expect(store.get(sensor.id)).toBeNull();
		expect(store.add(addRequest(sensor.id))).toMatchObject({ stored: false, code: "exists" });
		expect(store.rename(sensor.id, "Fridge", 2)).toMatchObject({ stored: false, code: "not_supported" });
		expect(store.remove(sensor.id, 2)).toMatchObject({ deleted: false, code: "not_supported" });
		expect(store.rename(lamp.id, "Desk lamp", 1)).toMatchObject({ stored: true });
		expect(JSON.parse(fs.readFileSync(file, "utf8")).records).toContainEqual(sensor);

		const others = Array.from({ length: DEVICE_MAX_RECORDS - 1 }, (_, i) =>
			device(`aa:bb:cc:dd:ee:${i.toString(16).padStart(2, "0")}`, { name: `Lamp ${i}` }),
		);
		fs.writeFileSync(file, JSON.stringify({ revision: 2, records: [...others, sensor] }));
		expect(openDeviceStore(dataDir).add(addRequest("bb:bb:cc:dd:ee:ff"))).toMatchObject({ code: "full" });
	});

	it("serializes writes for one device and runs another device concurrently", async () => {
		const store = openDeviceStore(fresh());
		const order: string[] = [];
		const writes: string[] = [];
		let releaseFirst: () => void = () => {};
		let signalStarted: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const first = store.perDevice("aa:bb:cc:dd:ee:ff", async () => {
			order.push("first-start");
			signalStarted();
			await held;
			writes.push("device-a:first");
			order.push("first-end");
		});
		await started;
		const second = store.perDevice("aa:bb:cc:dd:ee:ff", () => {
			writes.push("device-a:second");
			order.push("second");
		});
		await store.perDevice("11:22:33:44:55:66", () => {
			writes.push("device-b:other");
			order.push("other");
		});
		expect(order).toEqual(["first-start", "other"]);
		expect(writes).toEqual(["device-b:other"]);

		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "other", "first-end", "second"]);
		expect(writes).toEqual(["device-b:other", "device-a:first", "device-a:second"]);
	});
});
