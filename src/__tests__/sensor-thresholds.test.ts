import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SensorsClear } from "../gateway/assistant/sensorsClear.js";
import { composeDevices } from "../gateway/compose/composeDevices.js";
import { type Automations, createAutomations } from "../gateway/computed/automations.js";
import { type ComputedFields, createComputedFields } from "../gateway/computed/computedFields.js";
import { thresholdAutomations, thresholdIds } from "../gateway/computed/thresholds.js";
import { createSensorThresholds, type SensorThresholds } from "../gateway/devices/sensorThresholds.js";
import { createDeviceStore } from "../gateway/devices/store.js";
import { openDurable } from "../shared/durable-store.js";
import { known } from "../shared/expressions.js";
import { VALUE_OP_KINDS } from "../shared/schemasConsoleOp.js";
import { DEVICE_TOOL_OFFERS } from "../shared/schemasDeviceTool.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const MAC = "ce:1c:44:06:3c:5d";
const warm = { name: "GVH5110_3C5D", data: { "1": "010103bac864" }, services: ["ec88"] };
const cold = { name: "GVH5110_3C5D", data: { "1": "010180d16c5a" }, services: ["ec88"] };
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Faults {
	/** Automation puts to refuse. */
	automationPuts: number;
	thresholdSaves: boolean;
}

interface ThresholdSeed {
	device: string;
	measure: string;
	low?: number;
	high?: number;
	deadZone: number;
	coolDownSec: number;
	revision: number;
}

function fixture(home = true, seededThresholds: ThresholdSeed[] = []) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensor-thresholds-"));
	roots.push(dataDir);
	let clock = 1_000;
	const ambient = fakeAmbient({ now: () => clock, drive: "manual" });
	const faults: Faults = { automationPuts: 0, thresholdSaves: true };
	let snapshot: unknown = null;
	const deviceState = {
		load: () => snapshot,
		saveChecked: (next: unknown) => {
			snapshot = structuredClone(next);
		},
	};
	const build = () => {
		let fields: ComputedFields | undefined;
		let automations: Automations | undefined;
		let thresholds: SensorThresholds | undefined;
		const deviceStore = createDeviceStore({ store: deviceState, onChanged: () => fields?.typesChanged() });
		const devices = composeDevices({
			dataDir,
			ambient,
			deviceStore,
			relayToHost: async () => ({ ok: false, errorKind: "daemon_away" }) as never,
			onIngested: (keys) => fields?.inputsChanged(keys),
			sightings: () => warm,
			thresholds: {
				read: (record) => thresholds?.read(record) ?? [],
				put: (record, op) => thresholds?.put(record, op) ?? { kind: "refused", code: "write_failed" },
				forget: (device) => thresholds?.forget(device) ?? true,
			},
		});
		fields = openDurable(dataDir, "computed-fields", (records) =>
			openDurable(dataDir, "computed-state", (state) =>
				createComputedFields({
					records,
					state,
					newIncarnation: () => ambient.newId(),
					now: () => ambient.now(),
					input: devices.sensorInput,
					onCommit: () => automations?.drain(),
				}),
			),
		);
		automations = openDurable(dataDir, "automations", (records) =>
			openDurable(dataDir, "automation-state", (state) =>
				createAutomations({
					records,
					state,
					fields: fields as ComputedFields,
					newIncarnation: () => ambient.newId(),
					now: () => ambient.now(),
					isHome: () => home,
				}),
			),
		);
		const held = automations;
		const flaky: Automations = {
			...held,
			put: (id, body, base, options) => {
				if (faults.automationPuts === 0) return held.put(id, body, base, options);
				faults.automationPuts -= 1;
				return { stored: false, reason: "not saved; try again" };
			},
		};
		thresholds = openDurable(dataDir, "sensor-thresholds", (store) =>
			createSensorThresholds({
				store: {
					load: () => store.load(),
					saveChecked: (next) => {
						if (!faults.thresholdSaves) throw new Error("disk full");
						store.saveChecked(next);
					},
				},
				fields: fields as ComputedFields,
				automations: flaky,
				record: (id) => devices.record(id),
				records: () => devices.records(),
				holds: (id) => devices.holds(id),
			}),
		);
		thresholds.start();
		fields.start();
		return { devices, fields: fields as ComputedFields, automations: held, thresholds };
	};
	const seed = createDeviceStore({ store: deviceState, onChanged: () => {} }).addSensor({
		mac: MAC,
		name: "Freezer",
		driver: "govee",
		radio: "gateway",
		definition: "govee-h5110",
	});
	if (!seed.stored) throw new Error(seed.reason);
	if (seededThresholds.length > 0) {
		openDurable(dataDir, "sensor-thresholds", (store) =>
			store.saveChecked({ v: 1, thresholds: seededThresholds, unswept: [] }),
		);
	}
	let current = build();
	return {
		dataDir,
		ambient,
		faults,
		get now() {
			return clock;
		},
		set now(value: number) {
			clock = value;
		},
		get devices() {
			return current.devices;
		},
		get fields() {
			return current.fields;
		},
		get automations() {
			return current.automations;
		},
		get thresholds() {
			return current.thresholds;
		},
		async restart() {
			await current.devices.close();
			current = build();
		},
	};
}

const rowsOf = (world: { fields: ComputedFields; automations: Automations }) => {
	const prefix = thresholdIds(MAC, "").field;
	return [...world.fields.list(), ...world.automations.list()]
		.map(({ id }) => id)
		.filter((id) => id.startsWith(prefix))
		.sort();
};

const put = (revision: number, low: number | undefined) => ({
	kind: "sensor_threshold_put" as const,
	id: MAC,
	measure: "temperature",
	...(low === undefined ? {} : { low }),
	deadZone: 1,
	coolDownSec: 0,
	revision,
});

describe("sensor threshold composition", () => {
	it("queues one Sensors event, clears it, and reads the 24-hour extremes", async () => {
		const world = fixture();
		try {
			expect(VALUE_OP_KINDS.has("sensor_threshold_put")).toBe(true);
			expect(DEVICE_TOOL_OFFERS.sensor_threshold_put).toBe(false);
			const threshold = await world.devices.console(put(0, 10));
			expect(threshold).toMatchObject({ kind: "ok", threshold: { low: 10, revision: 1 } });
			world.devices.ingestGatewayAdvert(MAC, warm, 1_000);
			world.devices.ingestGatewayAdvert(MAC, cold, 2_000);
			const page = await world.automations.watcher.list!({ scope: "all" }, new AbortController().signal);
			expect(page.events).toHaveLength(1);
			expect(page.events[0]?.fields).toEqual({
				automation: expect.any(String),
				field: "Temperature",
				value: "low",
			});
			const member = page.events[0]?.id;
			if (!member) throw new Error("expected a sensor event");
			const clear = new SensorsClear((members) => world.automations.clear(members));
			const answer = await clear.run(
				{ members: [member] },
				{ signal: new AbortController().signal, ambient: world.ambient },
			);
			expect(answer.threads).toEqual([{ threadId: expect.stringMatching(/:[0-9a-f]{12}$/), outcome: "done" }]);
			expect(
				(await world.automations.watcher.list!({ scope: "all" }, new AbortController().signal)).events,
			).toEqual([]);
			const read = await world.devices.console({ kind: "device_read", id: MAC });
			expect(read).toMatchObject({
				kind: "sensor",
				model: "H5110",
				payloads: [
					{ at: 2_000, radio: "gateway", data: { "1": "010180d16c5a" } },
					{ at: 1_000, radio: "gateway", data: { "1": "010103bac864" } },
				],
				thresholds: [{ measure: "temperature", low: 10, deadZone: 1, coolDownSec: 0, revision: 1 }],
			});
			if (read.kind !== "sensor") throw new Error("sensor read expected");
			expect(read.readings.find((item) => item.spec.field === "temperature")).toMatchObject({
				alerts: ["low", "high"],
				value: -5.3,
				low: { value: -5.3, at: 2_000 },
				high: { value: 24.4, at: 1_000 },
			});
		} finally {
			await world.devices.close();
		}
	});

	it("refuses alert sides the definition does not offer", async () => {
		const world = fixture();
		try {
			const temperature = await world.devices.console({ ...put(0, undefined), high: 30 });
			const humidity = await world.devices.console({
				...put(0, undefined),
				measure: "humidity",
				high: 60,
			});
			const battery = await world.devices.console({
				...put(0, undefined),
				measure: "battery",
				high: 80,
			});
			expect(temperature).toMatchObject({ kind: "ok", threshold: { high: 30 } });
			expect(humidity).toMatchObject({ kind: "refused", refusal: { code: "invalid" } });
			expect(battery).toMatchObject({ kind: "refused", refusal: { code: "invalid" } });
		} finally {
			await world.devices.close();
		}
	});

	it("filters an unoffered side from startup, reads, and the next put", async () => {
		const world = fixture(true, [
			{ device: MAC, measure: "humidity", low: 10, high: 20, deadZone: 1, coolDownSec: 0, revision: 7 },
		]);
		try {
			const highId = thresholdIds(MAC, "humidity").high;
			expect(world.automations.list().find((row) => row.id === highId)?.body.enabled).toBe(false);
			const original = openDurable(world.dataDir, "sensor-thresholds", (store) => store.load()) as {
				thresholds: ThresholdSeed[];
			};
			expect(original.thresholds.find((entry) => entry.measure === "humidity")).toMatchObject({
				low: 10,
				high: 20,
			});
			world.devices.ingestGatewayAdvert(MAC, warm, 1_000);
			expect(
				(await world.automations.watcher.list!({ scope: "all" }, new AbortController().signal)).events,
			).toEqual([]);

			const read = await world.devices.console({ kind: "device_read", id: MAC });
			if (read.kind !== "sensor") throw new Error("sensor read expected");
			const threshold = read.thresholds?.find((entry) => entry.measure === "humidity");
			expect(threshold).toEqual({ measure: "humidity", low: 10, deadZone: 1, coolDownSec: 0, revision: 7 });
			if (!threshold) throw new Error("humidity threshold expected");

			const saved = await world.devices.console({
				kind: "sensor_threshold_put",
				id: MAC,
				measure: "humidity",
				low: 10,
				deadZone: 1,
				coolDownSec: 0,
				revision: threshold.revision,
			});
			expect(saved).toMatchObject({ kind: "ok", threshold: { measure: "humidity", low: 10, revision: 8 } });
			const stored = openDurable(world.dataDir, "sensor-thresholds", (store) => store.load()) as {
				thresholds: ThresholdSeed[];
			};
			expect(stored.thresholds.find((entry) => entry.measure === "humidity")).toEqual({
				device: MAC,
				measure: "humidity",
				low: 10,
				deadZone: 1,
				coolDownSec: 0,
				revision: 8,
			});
		} finally {
			await world.devices.close();
		}
	});

	it("lets a revision-zero put replace a hidden-only threshold", async () => {
		const world = fixture(true, [
			{ device: MAC, measure: "humidity", high: 20, deadZone: 1, coolDownSec: 0, revision: 4 },
		]);
		try {
			const read = await world.devices.console({ kind: "device_read", id: MAC });
			expect(read).toMatchObject({ kind: "sensor", thresholds: [] });
			const saved = await world.devices.console({
				kind: "sensor_threshold_put",
				id: MAC,
				measure: "humidity",
				low: 10,
				deadZone: 1,
				coolDownSec: 0,
				revision: 0,
			});
			expect(saved).toMatchObject({ kind: "ok", threshold: { measure: "humidity", low: 10 } });
			const stored = openDurable(world.dataDir, "sensor-thresholds", (store) => store.load()) as {
				thresholds: ThresholdSeed[];
			};
			expect(stored.thresholds.find((entry) => entry.measure === "humidity")).not.toHaveProperty("high");
		} finally {
			await world.devices.close();
		}
	});

	it("refuses a dead zone that removes the two-sided band", async () => {
		const world = fixture();
		try {
			expect(await world.devices.console(put(0, 10))).toMatchObject({ kind: "ok", threshold: { low: 10 } });
			const refused = await world.devices.console({ ...put(1, 10), high: 11 });
			expect(refused).toMatchObject({ kind: "refused", refusal: { code: "invalid" } });
			expect(await world.devices.console({ kind: "device_read", id: MAC })).toMatchObject({
				thresholds: [{ measure: "temperature", low: 10, deadZone: 1, revision: 1 }],
			});
		} finally {
			await world.devices.close();
		}
	});

	it("accepts a lost reply once, refuses an old revision, clears both sides, sets again, and goes with its sensor", async () => {
		const world = fixture();
		try {
			const first = await world.devices.console(put(0, 10));
			const retry = await world.devices.console(put(0, 10));
			const updated = await world.devices.console(put(1, 11));
			const stale = await world.devices.console(put(0, 12));
			expect(first).toMatchObject({ kind: "ok", threshold: { revision: 1 } });
			expect(retry).toEqual(first);
			expect(updated).toMatchObject({ kind: "ok", threshold: { low: 11, revision: 2 } });
			expect(stale).toMatchObject({ kind: "refused", refusal: { code: "stale" } });
			const ids = thresholdIds(MAC, "temperature");
			const removed = await world.devices.console({
				...put(2, undefined),
			});
			expect(removed).toMatchObject({ kind: "ok", threshold: null });
			expect(world.fields.get(ids.field)).toBeNull();
			expect(world.automations.list().some(({ id }) => id === ids.low || id === ids.high)).toBe(false);
			const again = await world.devices.console(put(0, 9));
			expect(again).toMatchObject({ kind: "ok", threshold: { low: 9 } });
			// A delayed edit from before the clear is stale.
			expect(await world.devices.console(put(1, 11))).toMatchObject({
				kind: "refused",
				refusal: { code: "stale" },
			});
			expect(await world.devices.console(put(0, 9))).toEqual(again);
			await world.devices.console({ kind: "device_remove", id: MAC, revision: 1 });
			expect(world.fields.get(ids.field)).toBeNull();
			expect(world.automations.list().some(({ id }) => id === ids.low || id === ids.high)).toBe(false);
		} finally {
			await world.devices.close();
		}
	});

	it("re-reads stale bands without a false alert and refuses alerts off home", async () => {
		const world = fixture(false);
		try {
			await world.devices.console(put(0, 10));
			world.devices.ingestGatewayAdvert(MAC, warm, world.now);
			world.devices.ingestGatewayAdvert(MAC, cold, world.now + 1_000);
			const ids = thresholdIds(MAC, "temperature");
			expect(world.fields.value(ids.field)).toEqual(known("low"));
			expect(world.automations.runs().map((run) => run.outcome)).toEqual(["refused"]);
			expect(
				(await world.automations.watcher.list!({ scope: "all" }, new AbortController().signal)).events,
			).toEqual([]);
			world.now = 16 * 60_000;
			world.devices.flushReadings();
			world.fields.inputsChanged(world.devices.sensorInputKeys());
			expect(world.fields.value(ids.field).known).toBe(false);
			world.devices.ingestGatewayAdvert(MAC, cold, world.now);
			expect(world.fields.value(ids.field)).toEqual(known("low"));
			expect(world.automations.runs().map((run) => run.outcome)).toEqual(["refused"]);
			expect(
				(await world.automations.watcher.list!({ scope: "all" }, new AbortController().signal)).events,
			).toEqual([]);
		} finally {
			await world.devices.close();
		}
	});
	it("keeps thresholds through a repeated or refused add and drops them on a fresh pairing", async () => {
		const world = fixture();
		try {
			await world.devices.console(put(0, 10));
			const add = { kind: "device_add" as const, mac: MAC, name: "Freezer", radio: "gateway" as const };
			expect(await world.devices.console(add)).toMatchObject({ kind: "ok" });
			expect(await world.devices.console({ ...add, name: "Fridge" })).toMatchObject({
				kind: "refused",
				refusal: { code: "exists" },
			});
			expect(await world.devices.console({ kind: "device_read", id: MAC })).toMatchObject({
				thresholds: [{ low: 10 }],
			});
			world.faults.thresholdSaves = false;
			expect(await world.devices.console({ kind: "device_remove", id: MAC, revision: 1 })).toEqual({
				kind: "ok",
			});
			world.faults.thresholdSaves = true;
			expect(await world.devices.console(add)).toMatchObject({ kind: "ok" });
			expect(await world.devices.console({ kind: "device_read", id: MAC })).toMatchObject({ thresholds: [] });
			expect(rowsOf(world)).toEqual([]);
		} finally {
			await world.devices.close();
		}
	});

	it("drops a removed sensor's alert rows at restart when the remove could not", async () => {
		const world = fixture();
		try {
			await world.devices.console(put(0, 10));
			world.faults.thresholdSaves = false;
			await world.devices.console({ kind: "device_remove", id: MAC, revision: 1 });
			world.faults.thresholdSaves = true;
			expect(rowsOf(world)).not.toEqual([]);
			await world.restart();
			expect(rowsOf(world)).toEqual([]);
		} finally {
			await world.devices.close();
		}
	});

	it("re-derives alert rows that did not land, on the tick and at restart", async () => {
		const world = fixture();
		try {
			const ids = thresholdIds(MAC, "temperature");
			world.faults.automationPuts = 1;
			expect(await world.devices.console(put(0, 10))).toMatchObject({ kind: "ok", threshold: { revision: 1 } });
			expect(rowsOf(world)).toEqual([ids.field, ids.high].sort());
			world.thresholds.tick();
			expect(rowsOf(world)).toEqual([ids.field, ids.high, ids.low].sort());
			const low = world.automations.list().find(({ id }) => id === ids.low);
			if (!low) throw new Error("low alert expected");
			world.automations.remove(ids.low, low.revision);
			const stray = thresholdIds(MAC, "humidity").low;
			world.automations.put(
				stray,
				{
					...thresholdAutomations({
						device: MAC,
						measure: "humidity",
						label: "Humidity",
						high: 80,
						deadZone: 1,
						coolDownSec: 0,
					}).high,
				},
				0,
			);
			await world.restart();
			expect(rowsOf(world)).toEqual([ids.field, ids.high, ids.low].sort());
			expect(await world.devices.console({ kind: "device_read", id: MAC })).toMatchObject({
				thresholds: [{ low: 10, revision: 1 }],
			});
		} finally {
			await world.devices.close();
		}
	});
});
