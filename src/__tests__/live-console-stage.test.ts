import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeDevices } from "../gateway/compose/composeDevices.js";
import { type ConsoleCaller, composeLiveConsole } from "../gateway/compose/composeLiveConsole.js";
import { type Automations, createAutomations } from "../gateway/computed/automations.js";
import { type ComputedFields, createComputedFields } from "../gateway/computed/computedFields.js";
import { thresholdIds } from "../gateway/computed/thresholds.js";
import { createSensorThresholds, type SensorThresholds } from "../gateway/devices/sensorThresholds.js";
import { createDeviceStore } from "../gateway/devices/store.js";
import { type ConsoleReaders, consoleEntities } from "../gateway/liveConsole/entities.js";
import { openDurable } from "../shared/durable-store.js";
import type { HostOpResult } from "../shared/host-op.js";
import type { ConsoleAssistantStateResult, TemperatureUnit } from "../shared/schemasAssistant.js";
import { SESSION_COMMANDS } from "../shared/session-commands.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const MAC = "ce:1c:44:06:3c:5d";
const warm = { name: "GVH5110_3C5D", data: { "1": "010103bac864" }, services: ["ec88"] };
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const HUB = {
	mac: "f2:3a:41:46:4e:42",
	name: "Govee_H5151_4E42",
	signal: -73,
	data: { "34817": "ec000101" },
	services: [],
};
const H5110 = {
	mac: "d5:9f:c0:86:0b:32",
	name: "GVH5110_0B32",
	signal: -61,
	data: { "1": "010103ab2c64" },
	services: ["ec88"],
};
const KETTLE = { mac: "aa:bb:cc:dd:ee:ff", signal: -80, data: { "76": "0102" }, services: [] };

const FIELD_ID = "threshold-ce1c443c5d-temperature";
const FIELDS = {
	list: () => [{ id: FIELD_ID, revision: 1, body: { label: "Freezer temperature", nodes: [] } }],
	value: () => ({ known: false, reason: "not heard for 31 minutes" }),
	invalidOf: () => null,
} as unknown as ComputedFields;
const AUTOMATIONS = {
	list: () => [
		{ id: "threshold-low", revision: 1, body: { label: "Freezer temperature below 21.0 °C", enabled: true } },
	],
	runs: () => [
		{ automation: "threshold-low", seq: 1, at: 1_794_694_000_000, outcome: "ran" },
		{ automation: "threshold-low", seq: 2, at: 1_794_694_500_000, outcome: "suppressed" },
	],
	invalidOf: () => null,
} as unknown as Automations;
const WATCHER = {
	id: "sensors",
	label: "Sensors",
	enabled: true,
	unread: 2,
	grants: ["entry-1"],
	secret: "A GitHub token",
	fieldSpecs: [{ kind: "text", field: "automation", label: "Automation" }],
	rules: {
		rules: [
			{
				id: "wake-freezer",
				conditions: [{ field: "automation", test: "contains", value: "Freezer" }],
				action: "wake",
				revision: 1,
			},
		],
		otherwise: { action: "inbox" },
	},
};

function world(
	unit: TemperatureUnit = "C",
	listened: HostOpResult = { ok: true, result: { devices: [HUB, KETTLE, H5110] } },
	loaded = false,
) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-console-"));
	roots.push(dataDir);
	const ambient = fakeAmbient({ now: () => 1_794_695_000_000 });
	let snapshot: unknown = null;
	const store = createDeviceStore({
		store: {
			load: () => snapshot,
			saveChecked: (next) => {
				snapshot = structuredClone(next);
			},
		},
		onChanged: () => {},
	});
	const added = store.addSensor({
		mac: MAC,
		name: "Freezer",
		driver: "govee",
		radio: "gateway",
		definition: "govee-h5110",
	});
	if (!added.stored) throw new Error(added.reason);
	const devices = composeDevices({
		dataDir,
		ambient,
		deviceStore: store,
		relayToHost: async () => ({ ok: false, errorKind: "daemon_away" }) as never,
	});
	devices.ingestGatewayAdvert(MAC, warm, ambient.now() - 60_000);
	let caller: ConsoleCaller = "host";
	const windows: number[] = [];
	const stage = composeLiveConsole({
		ambient,
		readers: {
			gateway: () => ({ id: "sakura", version: "1.0.0", router: null }),
			devices: () => devices,
			fields: () => (loaded ? FIELDS : undefined),
			automations: () => (loaded ? AUTOMATIONS : undefined),
			thresholds: () => undefined,
			assistant: () => ({ watchers: loaded ? [WATCHER] : [] }) as unknown as ConsoleAssistantStateResult,
			temperatureUnit: () => unit,
			bluetoothListen: async (windowMs) => {
				windows.push(windowMs);
				return listened;
			},
		},
		callerOf: () => caller,
	});
	const ask = async (expr?: string) => {
		const route = stage.routes.get(SESSION_COMMANDS.console.path);
		if (!route) throw new Error("route expected");
		const response = await route(new Request("http://gateway/console/eval"), expr === undefined ? {} : { expr });
		return response.json();
	};
	return {
		ask,
		windows,
		post: async (body: unknown) => {
			const route = stage.routes.get(SESSION_COMMANDS.console.path);
			if (!route) throw new Error("route expected");
			return route(new Request("http://gateway/console/eval"), body);
		},
		as: (next: ConsoleCaller) => {
			caller = next;
		},
		close: () => devices.close(),
	};
}

describe("live console stage", () => {
	it("serves host sessions only, and describes itself when asked nothing", async () => {
		const gateway = world();
		try {
			const listed = await gateway.ask();
			expect(listed).toMatchObject({ kind: "ok", registryHash: expect.any(String) });
			expect(listed.text).toContain("sensors.read(device: Text) -> Sensor");
			gateway.as("not_served");
			expect(await gateway.ask("gateway.id")).toEqual({ kind: "not_served" });
			gateway.as("unauthenticated");
			expect(await gateway.ask("gateway.id")).toEqual({ kind: "unauthenticated" });
		} finally {
			await gateway.close();
		}
	});

	it("reads a sensor by name in the owner's unit, and decodes its held payload through a definition", async () => {
		const gateway = world("F");
		try {
			expect(await gateway.ask('sensors.read("freezer").readings[0].shown')).toMatchObject({ text: "75.9 °F" });
			expect(await gateway.ask('sensors.read("freezer").readings[0].value')).toMatchObject({ text: "75.92" });
			expect(await gateway.ask('sensors.extremes("freezer", "temperature").high.shown')).toMatchObject({
				text: "75.9 °F",
			});
			expect(await gateway.ask("[bluetooth.listen(1), bluetooth.listen(1)]")).toMatchObject({
				issue: { code: "too_slow" },
			});
			expect((await gateway.ask("sensors.list")).text).toContain("main: Temperature 75.9 °F");
			const decoded = await gateway.ask(
				'Definition.decode("govee-h5110", sensors.payloads("Freezer")[0]).temperature',
			);
			expect(decoded).toMatchObject({ kind: "ok", text: "24.4" });
		} finally {
			await gateway.close();
		}
	});

	it("listens to everything heard, loudest first, marking each family and what is never paired", async () => {
		const gateway = world();
		try {
			const heard = await gateway.ask('bluetooth.listen(5).where("family", "govee")');
			expect(heard.text.split("\n").filter((line: string) => line.startsWith("- "))).toEqual([
				"- mac: d5:9f:c0:86:0b:32",
				"- mac: f2:3a:41:46:4e:42",
			]);
			expect(heard.text).toContain("unsupported: yes");
			expect(await gateway.ask("bluetooth.listen(999)")).toMatchObject({ issue: { code: "wrong_args" } });
		} finally {
			await gateway.close();
		}
		const down = world("C", { ok: false, error: "host daemon offline - terminal unavailable" });
		try {
			expect(await down.ask("bluetooth.listen()")).toMatchObject({
				kind: "error",
				issue: { code: "host_failed" },
			});
		} finally {
			await down.close();
		}
	});

	it("lists fields with their unknown reason, runs newest first by label, and watchers' health", async () => {
		const gateway = world("C", undefined, true);
		try {
			expect((await gateway.ask("fields.list")).text).toContain("value:\n    unknown: not heard for 31 minutes");
			const runs = await gateway.ask("automations.runs.first()");
			expect(runs.text).toContain("outcome: suppressed");
			expect(runs.text).toContain("label: Freezer temperature below 21.0 °C");
			expect((await gateway.ask('watchers.list.where("id", "sensors").first().unread')).text).toBe("2");
			const full = (await gateway.ask('watchers.get("sensors")')).text;
			expect(full).not.toContain("GitHub token");
			expect(full).not.toContain("entry-1");
			const decided = await gateway.ask(
				'watchers.test("sensors", {automation: "Freezer temperature below 21.0 °C"})',
			);
			expect(decided.text).toBe("rule: wake-freezer\naction: wake");
			expect((await gateway.ask(`fields.value("${FIELD_ID}")`)).text).toBe("unknown: not heard for 31 minutes");
		} finally {
			await gateway.close();
		}
	});

	it("refuses a malformed body before reading anything, and asks the radio for the window given", async () => {
		const gateway = world();
		try {
			expect((await gateway.post({ expr: 5 })).status).toBe(400);
			expect((await gateway.post({ expr: "gateway.id", limit: 0 })).status).toBe(400);
			await gateway.ask("bluetooth.listen(5)");
			await gateway.ask("bluetooth.listen()");
			expect(gateway.windows).toEqual([5_000, 120_000]);
		} finally {
			await gateway.close();
		}
	});

	it("says what is not loaded or not found, pointing at the expression", async () => {
		const gateway = world();
		try {
			expect(await gateway.ask("fields.list")).toMatchObject({ kind: "error", issue: { code: "not_ready" } });
			const missing = await gateway.ask('sensors.read("Garage")');
			expect(missing).toMatchObject({ kind: "error", issue: { code: "not_found" } });
			expect(missing.text.split("\n")[0]).toBe("error not_found: no device Garage");
		} finally {
			await gateway.close();
		}
	});
});

const cold = { name: "GVH5110_3C5D", data: { "1": "010180d16c5a" }, services: ["ec88"] };
const IDS = thresholdIds(MAC, "temperature");

const EVERY_MEMBER: Record<string, string> = {
	"gateway.id": "gateway.id",
	"gateway.version": "gateway.version",
	"gateway.router": "gateway.router",
	"gateway.temperatureUnit": "gateway.temperatureUnit",
	"devices.list": "devices.list",
	"devices.get": 'devices.get("Freezer")',
	"sensors.list": "sensors.list",
	"sensors.read": 'sensors.read("Freezer")',
	"sensors.payloads": 'sensors.payloads("Freezer")',
	"sensors.extremes": 'sensors.extremes("Freezer", "temperature")',
	"thresholds.list": "thresholds.list",
	"thresholds.of": 'thresholds.of("Freezer")',
	"fields.list": "fields.list",
	"fields.get": `fields.get("${IDS.field}")`,
	"fields.value": `fields.value("${IDS.field}")`,
	"fields.invalid": `fields.invalid("${IDS.field}")`,
	"fields.state": `fields.state("${IDS.field}")`,
	"automations.list": "automations.list",
	"automations.runs": "automations.runs",
	"automations.queue": "automations.queue",
	"automations.invalid": `automations.invalid("${IDS.low}")`,
	"automations.checkpoint": `automations.checkpoint("${IDS.low}")`,
	"watchers.list": "watchers.list",
	"watchers.get": 'watchers.get("sensors")',
	"watchers.rules": 'watchers.rules("sensors")',
	"watchers.test": 'watchers.test("sensors", {automation: "Freezer"})',
	"bluetooth.listen": "bluetooth.listen(1)",
	"Definition.all": "Definition.all",
	"Definition.get": 'Definition.get("govee-h5110")',
	"Definition.match": 'Definition.match(sensors.payloads("Freezer")[0])',
	"Definition.decode": 'Definition.decode("govee-h5110", sensors.payloads("Freezer")[0])',
};

function filesOf(dir: string): Record<string, string> {
	return Object.fromEntries(
		fs
			.readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const file = path.join(entry.parentPath, entry.name);
				return [path.relative(dir, file), fs.readFileSync(file, "base64")];
			}),
	);
}

describe("live console read-only fence", () => {
	it("reads every member over real stores and leaves every byte and the radio as it found them", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-console-fence-"));
		roots.push(dataDir);
		let clock = 1_794_690_000_000;
		const ambient = fakeAmbient({ now: () => clock, drive: "manual" });
		let snapshot: unknown = null;
		let fields: ComputedFields | undefined;
		let automations: Automations | undefined;
		let thresholds: SensorThresholds | undefined;
		const hostOps: string[] = [];
		const deviceStore = createDeviceStore({
			store: {
				load: () => snapshot,
				saveChecked: (next) => {
					snapshot = structuredClone(next);
				},
			},
			onChanged: () => {
				fields?.typesChanged();
				thresholds?.recordsChanged();
			},
		});
		const added = deviceStore.addSensor({
			mac: MAC,
			name: "Freezer",
			driver: "govee",
			radio: "gateway",
			definition: "govee-h5110",
		});
		if (!added.stored) throw new Error(added.reason);
		const devices = composeDevices({
			dataDir,
			ambient,
			deviceStore,
			relayToHost: async (op) => {
				hostOps.push(op.kind);
				return { ok: false, errorKind: "daemon_away" } as never;
			},
			onIngested: (keys) => fields?.inputsChanged(keys),
			thresholds: {
				read: (record) => thresholds?.read(record) ?? [],
				put: (record, op) => thresholds?.put(record, op) ?? { kind: "refused", code: "write_failed" },
				forget: (device) => thresholds?.forget(device) ?? true,
			},
		});
		openDurable(dataDir, "sensor-thresholds", (store) =>
			store.saveChecked({
				v: 1,
				thresholds: [
					{ device: MAC, measure: "temperature", low: 10, deadZone: 1, coolDownSec: 0, revision: 1 },
				],
				unswept: [],
			}),
		);
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
					isHome: () => true,
				}),
			),
		);
		thresholds = openDurable(dataDir, "sensor-thresholds", (store) =>
			createSensorThresholds({
				store,
				fields: fields as ComputedFields,
				automations: automations as Automations,
				record: (id) => devices.record(id),
				records: () => devices.records(),
				holds: (id) => devices.holds(id),
			}),
		);
		thresholds.start();
		fields.start();
		devices.ingestGatewayAdvert(MAC, warm, clock);
		clock += 60_000;
		devices.ingestGatewayAdvert(MAC, cold, clock);
		clock += 60_000;
		const readers: ConsoleReaders = {
			gateway: () => ({ id: "sakura", version: "1.0.0", router: null }),
			devices: () => devices,
			fields: () => fields,
			automations: () => automations,
			thresholds: () => thresholds,
			assistant: () => ({ watchers: [WATCHER] }) as unknown as ConsoleAssistantStateResult,
			temperatureUnit: () => "F",
			bluetoothListen: async () => {
				hostOps.push("bleListen");
				return { ok: true, result: { devices: [H5110] } };
			},
		};
		const stage = composeLiveConsole({ ambient, readers, callerOf: () => "host" });
		try {
			expect(automations.runs().length).toBeGreaterThan(0);
			const members = consoleEntities(readers).flatMap((entity) =>
				Object.keys(entity.members).map((name) => `${entity.name}.${name}`),
			);
			expect(Object.keys(EVERY_MEMBER).sort()).toEqual(members.sort());
			devices.flushReadings();
			const before = { files: filesOf(dataDir), snapshot: structuredClone(snapshot) };
			for (const [member, expr] of Object.entries(EVERY_MEMBER)) {
				const answer = await stage.answer("host", expr);
				expect({ member, kind: answer.kind }).toEqual({ member, kind: "ok" });
			}
			devices.flushReadings();
			expect({ files: filesOf(dataDir), snapshot }).toEqual(before);
			expect(hostOps).toEqual(["bleListen"]);
		} finally {
			await devices.close();
		}
	});
});
