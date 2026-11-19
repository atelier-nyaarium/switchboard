import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAutomationPair } from "../gateway/compose/composeAutomations.js";
import { composeDevices } from "../gateway/compose/composeDevices.js";
import { type ConsoleCaller, composeLiveConsole } from "../gateway/compose/composeLiveConsole.js";
import type { Automations } from "../gateway/computed/automations.js";
import type { ComputedFields } from "../gateway/computed/computedFields.js";
import { createDeviceStore } from "../gateway/devices/store.js";
import { type ConsoleReaders, consoleEntities } from "../gateway/liveConsole/entities.js";
import { CONSOLE_TEXT_BYTES } from "../gateway/liveConsole/render.js";
import type { HostOpResult } from "../shared/host-op.js";
import type { ConsoleAssistantStateResult, TemperatureUnit } from "../shared/schemasAssistant.js";
import { CONSOLE_VALUE_BYTES } from "../shared/schemasLiveConsole.js";
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
const FIELD = { id: FIELD_ID, revision: 1, body: { label: "Freezer temperature", nodes: [] } };
const FIELDS = {
	list: () => [FIELD],
	get: (id: string) => (id === FIELD_ID ? FIELD : undefined),
	value: () => ({ known: false, reason: "not heard for 31 minutes" }),
	stateOf: () => ({ seq: 4, transitions: [] }),
	invalidOf: () => null,
} as unknown as ComputedFields;
const AUTOMATIONS = {
	list: () => [
		{ id: "threshold-low", revision: 1, body: { label: "Freezer temperature below 21.0 °C", enabled: true } },
	],
	sentenceOf: () => "Freezer temperature below 21.0 °C",
	log: () => [
		{ automation: "threshold-low", seq: 1, at: 1_794_694_000_000, outcome: "ran" },
		{ automation: "threshold-low", seq: 2, at: 1_794_694_500_000, outcome: "suppressed" },
	],
	invalidOf: () => null,
	eventsOf: () => [
		{
			id: "wake-freezer",
			trigger: {
				kind: "event",
				source: "sensors",
				conditions: [{ field: "automation", test: "contains", value: "Freezer" }],
			},
			when: "now",
		},
	],
} as unknown as Automations;
const SOURCE = {
	id: "sensors",
	label: "Sensors",
	enabled: true,
	triggers: true,
	unread: 2,
	grants: ["entry-1"],
	secret: "A GitHub token",
	fieldSpecs: [{ kind: "text", field: "automation", label: "Automation" }],
	actions: [],
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
			assistant: () => ({ sources: loaded ? [SOURCE] : [] }) as unknown as ConsoleAssistantStateResult,
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
		owner: stage.console,
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
			expect((await gateway.ask('a = sensors.read("freezer"); a.name; sensors.list.count()')).text).toBe(
				"> a.name\nFreezer\n\n> sensors.list.count()\n1",
			);
			expect((await gateway.ask('a = sensors.read("freezer")')).text).toBe("saved for this call: a");
			expect((await gateway.ask('("ok"); 1')).text).toBe('> ("ok")\nok\n\n> 1\n1');
			const many = await gateway.ask(
				Array.from({ length: 16 }, () => 'definitions.get("govee-h5110")').join("; "),
			);
			expect(Buffer.byteLength(many.text, "utf8")).toBeLessThanOrEqual(CONSOLE_TEXT_BYTES);
			expect(many.text.match(/^> /gm)).toHaveLength(16);
			const decoded = await gateway.ask(
				'definitions.decode("govee-h5110", sensors.payloads("Freezer")[0]).temperature',
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

	it("lists fields with their unknown reason, runs newest first by label, and each source's health", async () => {
		const gateway = world("C", undefined, true);
		try {
			expect((await gateway.ask("fields.list")).text).toContain("value:\n    unknown: not heard for 31 minutes");
			const runs = await gateway.ask("automations.runs.first()");
			expect(runs.text).toContain("outcome: suppressed");
			expect(runs.text).toContain("label: Freezer temperature below 21.0 °C");
			expect((await gateway.ask('sources.list.where("id", "sensors").first().unread')).text).toBe("2");
			expect((await gateway.ask('sources.read("sensors").unread')).text).toBe("2");
			const full = (await gateway.ask('sources.get("sensors")')).text;
			expect(full).not.toContain("GitHub token");
			expect(full).not.toContain("entry-1");
			const decided = await gateway.ask(
				'sources.test("sensors", {automation: "Freezer temperature below 21.0 °C"})',
			);
			expect(decided.text).toContain("id: wake-freezer");
			expect(decided.text).toContain("wakes: yes");
			const missed = await gateway.ask('sources.test("sensors", {automation: "Pantry"})');
			expect(missed.text).toContain("wakes: no");
			expect((await gateway.ask(`fields.read("${FIELD_ID}").value`)).text).toBe(
				"unknown: not heard for 31 minutes",
			);
			expect(await gateway.ask('fields.read("nope")')).toMatchObject({ issue: { code: "not_found" } });
		} finally {
			await gateway.close();
		}
	});

	it("answers the owner with values, the registry's type, and a cut at the value cap", async () => {
		const gateway = world("F", undefined, true);
		try {
			const described = gateway.owner.describe();
			expect(described.description.entities.map((entity) => entity.name)).not.toContain("bluetooth");
			expect(gateway.owner.describe().registryHash).toBe(described.registryHash);
			expect(gateway.owner.ids()).toMatchObject({
				devices: [{ id: MAC, name: "Freezer", readings: ["temperature", "humidity", "battery"] }],
				fields: [{ id: FIELD_ID }],
				sources: [{ id: "sensors" }],
			});
			expect(await gateway.owner.evaluate('sensors.read("Freezer")')).toMatchObject({
				kind: "ok",
				results: [
					{
						type: "Sensor",
						value: {
							name: "Freezer",
							readings: expect.arrayContaining([
								expect.objectContaining({ key: "temperature", shown: "75.9 °F" }),
							]),
						},
					},
				],
			});
			expect(await gateway.owner.evaluate("devices")).toMatchObject({
				kind: "ok",
				results: [{ entity: "devices", value: null }],
			});
			const saved = await gateway.owner.evaluate('cold = sensors.read("Freezer"); cold.readings.count()');
			expect(saved).toMatchObject({
				kind: "ok",
				results: [{ assigned: "cold", type: "Sensor" }, { value: 3 }],
			});
			if (saved.kind !== "ok") throw new Error("a value expected");
			expect(
				await gateway.owner.evaluate("cold.readings.count()", undefined, {
					cold: { value: saved.results[0]?.value, type: "Sensor" },
				}),
			).toMatchObject({ kind: "ok", results: [{ value: 3 }] });
			expect(
				await gateway.owner.evaluate("big", undefined, { big: { value: "x".repeat(CONSOLE_VALUE_BYTES * 4) } }),
			).toMatchObject({ kind: "error", issue: { code: "too_big" }, registryHash: described.registryHash });
			expect(await gateway.owner.evaluate("bluetooth.listen(1)")).toMatchObject({
				kind: "error",
				issue: { code: "unknown_name" },
			});
			const crowded = composeLiveConsole({
				ambient: fakeAmbient({ now: () => 1_794_695_000_000 }),
				readers: {
					gateway: () => ({ id: "sakura", version: "1.0.0", router: null }),
					devices: () => undefined,
					fields: () => undefined,
					automations: () => undefined,
					assistant: () =>
						({
							sources: Array.from({ length: 100 }, (_, at) => ({
								...SOURCE,
								id: `w${at}`,
								label: "x".repeat(1_000),
							})),
						}) as unknown as ConsoleAssistantStateResult,
					temperatureUnit: () => "C",
					bluetoothListen: async () => ({ ok: false, error: "unused" }),
				},
				callerOf: () => "host",
			});
			const wide = await crowded.console.evaluate("sources.list", 100);
			expect(wide).toMatchObject({ kind: "ok", results: [{ type: "List<SourceSummary>", cut: { total: 100 } }] });
			expect(JSON.stringify(wide).length).toBeLessThan(CONSOLE_VALUE_BYTES + 200);
			expect(await crowded.console.evaluate("sources.list", 3)).toMatchObject({
				results: [{ cut: { shown: 3, total: 100 } }],
			});
			expect(await crowded.console.evaluate("all = sources.list")).toMatchObject({
				kind: "error",
				issue: { code: "too_big", message: expect.stringContaining("all is too large to save") },
			});
			const shared = await crowded.console.evaluate("sources.list.take(40); sources.list.take(40)", 40);
			expect(shared).toMatchObject({ kind: "ok", results: [{}, { cut: { total: 40 } }] });
			expect(JSON.stringify(shared).length).toBeLessThan(CONSOLE_VALUE_BYTES + 400);
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
const WATCH = "freezer-low";
const STORED_FIELD = "freezer-band";

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
	"fields.list": "fields.list",
	"fields.get": `fields.get("${STORED_FIELD}")`,
	"fields.read": `fields.read("${STORED_FIELD}")`,
	"automations.list": "automations.list",
	"automations.runs": "automations.runs",
	"automations.queue": "automations.queue",
	"automations.get": `automations.get("${WATCH}")`,
	"automations.read": `automations.read("${WATCH}")`,
	"sources.list": "sources.list",
	"sources.get": 'sources.get("sensors")',
	"sources.read": 'sources.read("sensors")',
	"sources.test": 'sources.test("sensors", {automation: "Freezer"})',
	"bluetooth.listen": "bluetooth.listen(1)",
	"definitions.list": "definitions.list",
	"definitions.get": 'definitions.get("govee-h5110")',
	"definitions.match": 'definitions.match(sensors.payloads("Freezer")[0])',
	"definitions.decode": 'definitions.decode("govee-h5110", sensors.payloads("Freezer")[0])',
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
		const hostOps: string[] = [];
		const deviceStore = createDeviceStore({
			store: {
				load: () => snapshot,
				saveChecked: (next) => {
					snapshot = structuredClone(next);
				},
			},
			onChanged: () => fields?.typesChanged(),
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
		});
		const pair = openAutomationPair({
			dataDir,
			newIncarnation: () => ambient.newId(),
			now: () => ambient.now(),
			input: devices.sensorInput,
			beforeDrain: () => devices.flushReadings(),
			automations: { isHome: () => true, reading: devices.watchedReading },
		});
		fields = pair.fields;
		automations = pair.automations;
		fields.start();
		automations.ownerPut(
			WATCH,
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
				actions: [{ kind: "tell_assistant", when: "quietly" }],
			},
			0,
		);
		fields.put(
			STORED_FIELD,
			{
				label: "Freezer band",
				nodes: [
					{ kind: "field", ref: { source: "device", device: MAC, key: "temperature" } },
					{ kind: "band", input: 0, low: 10, deadZone: 1 },
				],
			},
			0,
		);
		devices.ingestGatewayAdvert(MAC, warm, clock);
		clock += 60_000;
		devices.ingestGatewayAdvert(MAC, cold, clock);
		clock += 60_000;
		const readers: ConsoleReaders = {
			gateway: () => ({ id: "sakura", version: "1.0.0", router: null }),
			devices: () => devices,
			fields: () => fields,
			automations: () => automations,
			assistant: () => ({ sources: [SOURCE] }) as unknown as ConsoleAssistantStateResult,
			temperatureUnit: () => "F",
			bluetoothListen: async () => {
				hostOps.push("bleListen");
				return { ok: true, result: { devices: [H5110] } };
			},
		};
		const stage = composeLiveConsole({ ambient, readers, callerOf: () => "host" });
		try {
			expect(automations.log().length).toBeGreaterThan(0);
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
			expect(stage.console.ids().devices).toHaveLength(1);
			stage.console.describe();
			devices.flushReadings();
			expect({ files: filesOf(dataDir), snapshot }).toEqual(before);
			expect(hostOps).toEqual(["bleListen"]);
		} finally {
			await devices.close();
		}
	});
});
