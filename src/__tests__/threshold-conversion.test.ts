import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeDevices } from "../gateway/compose/composeDevices.js";
import { type Automations, createAutomations } from "../gateway/computed/automations.js";
import { type ComputedFields, createComputedFields } from "../gateway/computed/computedFields.js";
import { createDeviceStore } from "../gateway/devices/store.js";
import { alertId, alertPrefix, createThresholdConversion } from "../gateway/devices/thresholdConversion.js";
import { openDurable } from "../shared/durable-store.js";
import type { Automation } from "../shared/schemasAutomation.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const MAC = "ce:1c:44:06:3c:5d";
const GONE = "d5:9f:c0:86:0b:32";
const warm = { name: "GVH5110_3C5D", data: { "1": "010103bac864" }, services: ["ec88"] };
const cold = { name: "GVH5110_3C5D", data: { "1": "010180d16c5a" }, services: ["ec88"] };
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const tells: Automation["actions"] = [{ kind: "tell_assistant", when: "quietly" }];
const bandId = (device: string) => `${alertPrefix(device)}temperature`;

/** Stored threshold fixture. */
function storedAlert(device: string, sides: { low?: number; high?: number }) {
	const band = {
		label: "Freezer temperature",
		nodes: [
			{ kind: "field", ref: { source: "device", device, key: "temperature" } },
			{ kind: "band", input: 0, ...sides, deadZone: 1 },
		],
	};
	const alert = (side: "low" | "high") => ({
		id: alertId(device, "temperature", side),
		revision: 1,
		incarnation: `a-${device}-${side}`,
		kind: "automation",
		body: {
			label: `Freezer temperature ${side}`,
			enabled: true,
			trigger: { kind: "value", field: bandId(device), becomes: side, coolDownSec: 3_600 },
			actions: tells,
		},
	});
	return {
		entry: { device, measure: "temperature", ...sides, deadZone: 1, coolDownSec: 3_600, revision: 1 },
		field: { id: bandId(device), revision: 1, incarnation: `f-${device}`, kind: "computed_field", body: band },
		alerts: (["low", "high"] as const).map((side) => {
			const row = alert(side);
			return { ...row, body: { ...row.body, enabled: sides[side] !== undefined } };
		}),
	};
}

interface Seed {
	thresholds?: unknown[];
	unswept?: string[];
	fields?: unknown[];
	automations?: unknown[];
	state?: unknown;
}

function fixture(seed: Seed = {}, failWrites = 0) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "threshold-conversion-"));
	roots.push(dataDir);
	const write = (name: string, held: unknown) =>
		fs.writeFileSync(path.join(dataDir, `${name}.json`), JSON.stringify(held));
	if (seed.fields) write("computed-fields", seed.fields);
	if (seed.automations) write("automations", seed.automations);
	if (seed.state) write("automation-state", seed.state);
	if (seed.thresholds) {
		openDurable(dataDir, "sensor-thresholds", (store) =>
			store.saveChecked({ v: 1, thresholds: seed.thresholds, unswept: seed.unswept ?? [] }),
		);
	}
	const clock = 1_000;
	const ambient = fakeAmbient({ now: () => clock, drive: "manual" });
	const faults = { automationWrites: failWrites };
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
		const devices = composeDevices({
			dataDir,
			ambient,
			deviceStore: createDeviceStore({ store: deviceState, onChanged: () => fields?.typesChanged() }),
			relayToHost: async () => ({ ok: false, errorKind: "daemon_away" }) as never,
			onIngested: (keys) => fields?.inputsChanged(keys),
			sightings: () => warm,
		});
		fields = openDurable(dataDir, "computed-fields", (records) =>
			openDurable(dataDir, "computed-state", (state) =>
				createComputedFields({
					records,
					state,
					newIncarnation: () => ambient.newId(),
					now: () => ambient.now(),
					input: devices.sensorInput,
					derived: () => automations?.derivedFields() ?? [],
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
					isHome: () => true,
					reading: devices.watchedReading,
				}),
			),
		);
		const held = automations;
		const conversion = openDurable(dataDir, "sensor-thresholds", (stored) =>
			openDurable(dataDir, "sensor-thresholds-converted", (mark) =>
				createThresholdConversion({
					stored,
					mark,
					fields: fields as ComputedFields,
					automations: {
						list: () => held.list(),
						write: (intent) => {
							if (faults.automationWrites === 0) return held.write(intent);
							faults.automationWrites -= 1;
							return { written: false, reason: "not saved; try again" };
						},
					},
					record: (id) => devices.record(id),
					holds: (id) => devices.holds(id),
				}),
			),
		);
		conversion.run();
		fields.start();
		return { devices, fields: fields as ComputedFields, automations: held, conversion };
	};
	const added = createDeviceStore({ store: deviceState, onChanged: () => {} }).addSensor({
		mac: MAC,
		name: "Freezer",
		driver: "govee",
		radio: "gateway",
		definition: "govee-h5110",
	});
	if (!added.stored) throw new Error(added.reason);
	const storedBytes = () => {
		const file = path.join(dataDir, "sensor-thresholds.json");
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	};
	const seeded = storedBytes();
	let current = build();
	return {
		dataDir,
		faults,
		seeded,
		storedBytes,
		now: clock,
		get devices() {
			return current.devices;
		},
		get fields() {
			return current.fields;
		},
		get automations() {
			return current.automations;
		},
		get conversion() {
			return current.conversion;
		},
		async restart() {
			await current.devices.close();
			current = build();
		},
	};
}

/** Every row of a sensor page. */
const alertRows = (world: { fields: ComputedFields; automations: Automations }, device = MAC) =>
	[...world.fields.list(), ...world.automations.list()]
		.map(({ id }) => id)
		.filter((id) => id.startsWith(alertPrefix(device)))
		.sort();

const triggerOf = (world: { automations: Automations }, id: string) =>
	world.automations.list().find((record) => record.id === id)?.body.trigger;

describe("a sensor's stored thresholds", () => {
	it("become crossings their owner can edit, with the cool-down and last run they had", async () => {
		const freezer = storedAlert(MAC, { low: 10, high: 30 });
		const low = alertId(MAC, "temperature", "low");
		const high = alertId(MAC, "temperature", "high");
		const world = fixture({
			thresholds: [freezer.entry],
			fields: [freezer.field],
			automations: freezer.alerts,
			state: {
				automations: {
					[low]: { revision: 1, incarnation: `a-${MAC}-low`, fieldEpoch: "e0", handledSeq: 0, firedAt: 900 },
				},
				queue: { lastAt: 0, events: [] },
				log: [],
			},
		});
		try {
			world.devices.ingestGatewayAdvert(MAC, warm, world.now);
			world.devices.ingestGatewayAdvert(MAC, cold, world.now + 1_000);
			const row = world.automations.rows().find((held) => held.id === low);

			expect(alertRows(world)).toEqual([high, low]);
			expect(triggerOf(world, low)).toEqual({
				kind: "crossing",
				device: MAC,
				measure: "temperature",
				direction: "below",
				threshold: 10,
				deadZone: 1,
				coolDownSec: 3_600,
			});
			expect(triggerOf(world, high)).toMatchObject({ kind: "crossing", direction: "above", threshold: 30 });
			expect(row).toMatchObject({ lastRanAt: 900, sentence: expect.stringContaining("Freezer") });
			expect(row?.automation.label).toBeUndefined();
			expect(world.automations.runs().map((run) => run.outcome)).toEqual(["suppressed"]);

			const edited = { ...(row?.automation as Automation), enabled: false };
			expect(world.automations.ownerPut(low, edited, row?.revision ?? 0)).toMatchObject({ stored: true });
			const kept = world.automations.rows().find((held) => held.id === high);
			expect(world.automations.ownerRemove(high, kept?.revision ?? 0)).toMatchObject({ deleted: true });
			await world.restart();

			expect(alertRows(world)).toEqual([low]);
			expect(world.automations.list().find((record) => record.id === low)?.body.enabled).toBe(false);
			expect(world.conversion.pending()).toEqual([]);
			expect(world.storedBytes()).toBe(world.seeded);
		} finally {
			await world.devices.close();
		}
	});

	it("stay as they were while the write fails, and convert once it lands", async () => {
		const freezer = storedAlert(MAC, { low: 10 });
		const low = alertId(MAC, "temperature", "low");
		const world = fixture({ thresholds: [freezer.entry], fields: [freezer.field], automations: freezer.alerts }, 2);
		try {
			const held = [triggerOf(world, low)?.kind, alertRows(world), world.conversion.pending()];
			world.conversion.run();
			const again = world.conversion.pending();
			world.conversion.run();

			expect(held).toEqual(["value", [bandId(MAC), alertId(MAC, "temperature", "high"), low], [MAC]]);
			expect(again).toEqual([MAC]);
			expect([triggerOf(world, low)?.kind, alertRows(world), world.conversion.pending()]).toEqual([
				"crossing",
				[low],
				[],
			]);
		} finally {
			await world.devices.close();
		}
	});

	it("leave an owner's edit and delete alone when a lost mark runs them again", async () => {
		const freezer = storedAlert(MAC, { low: 10, high: 30 });
		const low = alertId(MAC, "temperature", "low");
		const high = alertId(MAC, "temperature", "high");
		const world = fixture({ thresholds: [freezer.entry], fields: [freezer.field], automations: freezer.alerts });
		try {
			const row = world.automations.rows().find((held) => held.id === low);
			const edited = { ...(row?.automation as Automation), enabled: false };
			world.automations.ownerPut(low, edited, row?.revision ?? 0);
			const deleted = world.automations.rows().find((held) => held.id === high);
			world.automations.ownerRemove(high, deleted?.revision ?? 0);
			fs.rmSync(path.join(world.dataDir, "sensor-thresholds-converted.json"));
			await world.restart();

			expect(world.automations.list().map(({ id, body }) => [id, body])).toEqual([[low, edited]]);
			expect(world.conversion.pending()).toEqual([]);
		} finally {
			await world.devices.close();
		}
	});

	it("go with a sensor that was removed, and leave a row that was never theirs", async () => {
		const freezer = storedAlert(MAC, { low: 10 });
		const gone = storedAlert(GONE, { low: 5, high: 25 });
		const plain = {
			id: `${alertPrefix(GONE)}mine`,
			revision: 1,
			incarnation: "p0",
			kind: "automation",
			body: { enabled: true, trigger: { kind: "interval", everyMin: 60 }, actions: tells },
		};
		const world = fixture({
			thresholds: [freezer.entry, gone.entry],
			fields: [freezer.field, gone.field],
			automations: [...freezer.alerts, ...gone.alerts, plain],
		});
		try {
			expect(alertRows(world, GONE)).toEqual([plain.id]);
			expect(alertRows(world)).toEqual([alertId(MAC, "temperature", "low")]);
			expect(world.conversion.pending()).toEqual([]);
		} finally {
			await world.devices.close();
		}
	});

	it("keep a band another automation still watches, and sweep a sensor left unswept", async () => {
		const freezer = storedAlert(MAC, { low: 10 });
		const gone = storedAlert(GONE, { high: 25 });
		const watcher = {
			id: "mine",
			revision: 1,
			incarnation: "w0",
			kind: "automation",
			body: {
				enabled: true,
				trigger: { kind: "value", field: bandId(MAC), becomes: "low", coolDownSec: 0 },
				actions: tells,
			},
		};
		const world = fixture({
			thresholds: [freezer.entry],
			unswept: [GONE],
			fields: [freezer.field, gone.field],
			automations: [...freezer.alerts, ...gone.alerts, watcher],
		});
		try {
			expect(alertRows(world)).toEqual([bandId(MAC), alertId(MAC, "temperature", "low")]);
			expect(alertRows(world, GONE)).toEqual([]);
			expect(world.automations.list().map((record) => record.id)).toContain("mine");
		} finally {
			await world.devices.close();
		}
	});

	it("leave a crossing invalid once its sensor is removed, and valid again once it is paired", async () => {
		const world = fixture();
		try {
			const invalid = () => world.automations.rows().map((row) => typeof row.invalid);
			world.automations.ownerPut(
				"watch",
				{
					enabled: true,
					trigger: {
						kind: "crossing",
						device: MAC,
						measure: "temperature",
						direction: "below",
						threshold: 10,
						deadZone: 1,
						coolDownSec: 0,
					},
					actions: tells,
				},
				0,
			);
			const held = invalid();
			await world.devices.console({ kind: "device_remove", id: MAC, revision: 1 });
			const removed = invalid();
			await world.devices.console({ kind: "device_add", mac: MAC, name: "Freezer", radio: "gateway" });

			expect([held, removed, invalid()]).toEqual([["undefined"], ["string"], ["undefined"]]);
		} finally {
			await world.devices.close();
		}
	});

	it("leave a Gateway that stored none as it is", async () => {
		const world = fixture();
		try {
			expect(world.conversion.pending()).toEqual([]);
			expect(world.automations.list()).toEqual([]);
			expect(fs.existsSync(path.join(world.dataDir, "sensor-thresholds-converted.json"))).toBe(false);
			expect(world.storedBytes()).toBeNull();
		} finally {
			await world.devices.close();
		}
	});
});
