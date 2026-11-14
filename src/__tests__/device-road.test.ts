import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { composeDevices, DEVICE_IDENTIFY_WAIT_MS, DEVICE_READ_WAIT_MS } from "../gateway/compose/composeDevices.js";
import { createKasaTransport, type KasaTransport } from "../gateway/devices/kasa/transport.js";
import { createDeviceRoad, Decline, type Shape, unwrap } from "../gateway/devices/road.js";
import { consoleShape } from "../gateway/devices/shapes.js";
import { createDeviceStore } from "../gateway/devices/store.js";
import { CONSOLE_ANSWER_WAIT_MS, CONSOLE_HOP_MARGIN_MS } from "../shared/console-protocol.js";
import type { DeviceConsoleOp, DeviceConsoleOpKind } from "../shared/schemasDevices.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { createFakeKasaPlug } from "../testing/fakeKasaPlug.js";

const MAC = "aa:bb:cc:dd:ee:ff";
const SENSOR_MAC = "aa:bb:cc:dd:ee:fe";
const CONSOLE_BOUND_MS = CONSOLE_ANSWER_WAIT_MS - CONSOLE_HOP_MARGIN_MS;
const NOT_STARTED_ANSWER = { kind: "refused", refusal: { code: "timeout", effect: "none" } };

function commandName(command: object): string {
	const [module] = Object.keys(command);
	const body = (command as Record<string, Record<string, unknown>>)[module!]!;
	return Object.keys(body)[0]!;
}

function sysinfo(mac: string) {
	return { system: { get_sysinfo: { mac, alias: "Lamp", relay_state: 0 } } };
}

function fresh(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `device-road-${label}-`));
}

const noHost = async () => ({ ok: false, errorKind: "daemon_away" }) as never;
const anyShape: Shape<unknown> = { decline: (why) => ({ declined: why }) };
const addLamp = { kind: "device_add", mac: MAC, address: "127.0.0.1", name: "Lamp" } as const;
const toggle = { kind: "device_set", id: MAC, verb: "toggle" } as const;

describe("device road", () => {
	it("records an unknown outcome when the confirm read aborts after the relay command landed", async () => {
		const dataDir = fresh("confirm");
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const plug = await createFakeKasaPlug({ mac: MAC });
		const base = createKasaTransport(plug.port);
		let relayed = false;
		const transport: KasaTransport = {
			request: async (_address, command, signal) => {
				const name = commandName(command);
				if (name === "set_relay_state") relayed = true;
				else if (name === "get_sysinfo" && relayed) {
					relayed = false;
					await ambient.advance(CONSOLE_BOUND_MS);
				}
				return base.request("127.0.0.1", command, signal);
			},
		};
		const stage = composeDevices({ dataDir, ambient, transport, relayToHost: noHost });
		try {
			await stage.console(addLamp);
			expect(await stage.console(toggle)).toMatchObject({
				kind: "refused",
				refusal: { code: "timeout", effect: "unknown" },
			});
			expect(await stage.console(toggle)).toMatchObject({
				kind: "refused",
				refusal: { code: "toggle_unknown", effect: "none" },
			});
			expect(plug.received().filter((row) => row.command === "set_relay_state")).toHaveLength(1);
		} finally {
			await stage.close();
			await plug.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("answers not started when the relay command never leaves, and keeps the toggle free", async () => {
		const dataDir = fresh("unsent");
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const plug = await createFakeKasaPlug({ mac: MAC });
		const base = createKasaTransport(plug.port);
		let cut = false;
		const transport: KasaTransport = {
			request: async (_address, command, signal) => {
				if (commandName(command) === "set_relay_state" && !cut) {
					cut = true;
					await ambient.advance(CONSOLE_BOUND_MS);
				}
				return base.request("127.0.0.1", command, signal);
			},
		};
		const stage = composeDevices({ dataDir, ambient, transport, relayToHost: noHost });
		try {
			await stage.console(addLamp);
			expect(await stage.console(toggle)).toEqual(NOT_STARTED_ANSWER);
			expect(await stage.console(toggle)).toMatchObject({ kind: "ok", state: { state: "on" } });
			expect(plug.received().filter((row) => row.command === "set_relay_state")).toHaveLength(1);
		} finally {
			await stage.close();
			await plug.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("ends a turn an operation left behind", async () => {
		const dataDir = fresh("orphan");
		let reads = 0;
		const plug = await createFakeKasaPlug({
			mac: MAC,
			behavior: (request) => (request.command === "get_sysinfo" && ++reads === 2 ? { kind: "hold" } : undefined),
		});
		const road = createDeviceRoad({ dataDir, ambient: fakeAmbient(), transport: createKasaTransport(plug.port) });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await road.onSlot("console", consoleShape("device_add"), MAC, async (slot) => {
				await slot.identify("127.0.0.1", MAC);
				return {
					kind: "ok" as const,
					record: unwrap(slot.write.add({ mac: MAC, address: "127.0.0.1", name: "Lamp" })),
				};
			});
			const answer = await road.operation("console", consoleShape("device_read"), async (op) => {
				void op.plug(MAC, (plug) => plug.drive((ctx) => plug.driver.read(plug.record, ctx)));
				await plug.waitForHeldReply();
				throw new Error("left behind");
			});
			expect(answer).toMatchObject({ kind: "refused", refusal: { code: "unreachable" } });
			expect(
				await road.onDevice("console", anyShape, MAC, async (plug) => {
					return (await plug.drive((ctx) => plug.driver.read(plug.record, ctx))).state;
				}),
			).toMatchObject({ state: "off" });
		} finally {
			warn.mockRestore();
			await road.close();
			await plug.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("answers a listing at its bound while a write holds the device", async () => {
		const dataDir = fresh("listing");
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const plug = await createFakeKasaPlug({
			mac: MAC,
			behavior: (request) => (request.command === "set_relay_state" ? { kind: "hold" } : undefined),
		});
		const stage = composeDevices({
			dataDir,
			ambient,
			transport: createKasaTransport(plug.port),
			relayToHost: noHost,
		});
		try {
			await stage.console(addLamp);
			const setting = stage.console({ kind: "device_set", id: MAC, verb: "on" });
			let setSettled = false;
			void setting.then(() => {
				setSettled = true;
			});
			await plug.waitForHeldReply();
			const listing = stage.assistant({ kind: "device_list" });
			await ambient.advance(DEVICE_READ_WAIT_MS);
			expect(await listing).toMatchObject({
				kind: "ok",
				devices: [{ id: MAC, name: "Lamp", kind: "switch", state: "unknown" }],
			});
			expect(setSettled).toBe(false);
			await ambient.advance(CONSOLE_BOUND_MS);
			expect(await setting).toMatchObject({ kind: "refused", refusal: { code: "timeout" } });
		} finally {
			await stage.close();
			await plug.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("closes promptly while a scan waits on the host", async () => {
		const dataDir = fresh("close");
		const stage = composeDevices({
			dataDir,
			ambient: fakeAmbient(),
			relayToHost: () => new Promise(() => {}),
		});
		try {
			const scanning = stage.console({ kind: "device_scan" });
			await stage.close();
			expect(await scanning).toEqual(NOT_STARTED_ANSWER);
		} finally {
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("declines every entry after close", async () => {
		const dataDir = fresh("fence");
		const plug = await createFakeKasaPlug({ mac: MAC });
		const relay = vi.fn(noHost);
		let snapshot: unknown = null;
		const deviceStore = createDeviceStore({
			store: {
				load: () => snapshot,
				saveChecked: (next) => {
					snapshot = structuredClone(next);
				},
			},
			onChanged: () => {},
		});
		const sensor = deviceStore.addSensor({ mac: SENSOR_MAC, name: "Sensor", driver: "govee", radio: "phones" });
		if (!sensor.stored) throw new Error(sensor.reason);
		const stage = composeDevices({
			dataDir,
			ambient: fakeAmbient(),
			transport: createKasaTransport(plug.port),
			relayToHost: relay,
			deviceStore,
		});
		try {
			await stage.console(addLamp);
			await stage.close();
			const commandsAfterClose = plug.received().length;
			const ops: { [K in DeviceConsoleOpKind]: Extract<DeviceConsoleOp, { kind: K }> } = {
				device_list: { kind: "device_list" },
				device_read: { kind: "device_read", id: MAC },
				device_reading_post: {
					kind: "device_reading_post",
					id: SENSOR_MAC,
					advert: { data: {}, services: [] },
					at: 1,
				},
				sensor_threshold_put: {
					kind: "sensor_threshold_put",
					id: SENSOR_MAC,
					measure: "temperature",
					high: 28,
					deadZone: 1,
					coolDownSec: 0,
					revision: 0,
				},
				device_scan: { kind: "device_scan" },
				device_home_network: { kind: "device_home_network" },
				device_add: { kind: "device_add", mac: "aa:bb:cc:dd:ee:01", address: "127.0.0.1", name: "Fan" },
				device_rename: { kind: "device_rename", id: MAC, name: "Desk lamp", revision: 1 },
				device_remove: { kind: "device_remove", id: MAC, revision: 1 },
				device_set: { kind: "device_set", id: MAC, verb: "on" },
				device_schedule_put: {
					kind: "device_schedule_put",
					id: MAC,
					revision: 1,
					base: { enabled: true, rules: [] },
					schedule: { enabled: true, rules: [] },
				},
				device_setting_put: {
					kind: "device_setting_put",
					id: MAC,
					revision: 1,
					setting: { driver: "kasa", setting: { key: "led", value: false } },
				},
			};
			for (const op of Object.values(ops)) {
				expect({ kind: op.kind, answer: await stage.console(op) }).toEqual({
					kind: op.kind,
					answer: NOT_STARTED_ANSWER,
				});
			}
			expect(await stage.assistant({ kind: "device_list" })).toEqual(NOT_STARTED_ANSWER);
			expect(await stage.assistant({ kind: "device_set", id: MAC, verb: "on" })).toEqual(NOT_STARTED_ANSWER);
			expect(plug.received()).toHaveLength(commandsAfterClose);
			expect(relay).not.toHaveBeenCalled();
		} finally {
			await plug.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("refuses a nested hold of the same device", async () => {
		const dataDir = fresh("reentry");
		const plug = await createFakeKasaPlug({ mac: MAC });
		const road = createDeviceRoad({ dataDir, ambient: fakeAmbient(), transport: createKasaTransport(plug.port) });
		try {
			await road.onSlot("console", consoleShape("device_add"), MAC, async (slot) => {
				await slot.identify("127.0.0.1", MAC);
				return {
					kind: "ok" as const,
					record: unwrap(slot.write.add({ mac: MAC, address: "127.0.0.1", name: "Lamp" })),
				};
			});
			const answer = await road.operation("console", anyShape, async (op) => {
				const outcome = await op.plug(MAC, async (plug) => {
					await expect(op.plug(MAC, async () => ({}))).rejects.toThrow();
					return (await plug.drive((ctx) => plug.driver.read(plug.record, ctx))).state;
				});
				if (!outcome.ok) throw new Decline(outcome.why);
				return outcome.value;
			});
			expect(answer).toMatchObject({ state: "off" });
		} finally {
			await road.close();
			await plug.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("commits a scan refresh whose identify lands after its bound", async () => {
		const dataDir = fresh("late-refresh");
		const ambient = fakeAmbient({ drive: "manual", now: () => 1_000 });
		const transport: KasaTransport = {
			request: async (address, command) => {
				if (commandName(command) !== "get_sysinfo") throw new Error("unexpected command");
				if (address === "10.0.0.2") await ambient.advance(DEVICE_IDENTIFY_WAIT_MS);
				return sysinfo(MAC);
			},
		};
		const stage = composeDevices({
			dataDir,
			ambient,
			transport,
			relayToHost: async () =>
				({
					ok: true,
					result: {
						candidates: [
							{
								mac: MAC,
								address: "10.0.0.2",
								alias: "Lamp",
								model: "HS103",
								hardware: "3.0",
								firmware: "1.0.3",
							},
						],
					},
				}) as never,
		});
		try {
			await stage.console({ kind: "device_add", mac: MAC, address: "10.0.0.1", name: "Lamp" });
			expect(await stage.console({ kind: "device_scan" })).toMatchObject({
				kind: "ok",
				candidates: [{ address: "10.0.0.2" }],
			});
			expect(await stage.console({ kind: "device_list" })).toMatchObject({
				kind: "ok",
				records: [{ id: MAC, address: "10.0.0.2", revision: 2 }],
			});
		} finally {
			await stage.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("returns raw payloads and source radios for a sensor without a definition", async () => {
		const dataDir = fresh("raw-sensor");
		let snapshot: unknown = null;
		const deviceStore = createDeviceStore({
			store: {
				load: () => snapshot,
				saveChecked: (next) => {
					snapshot = structuredClone(next);
				},
			},
			onChanged: () => {},
		});
		const added = deviceStore.addSensor({ mac: SENSOR_MAC, name: "Sensor", driver: "govee", radio: "phones" });
		if (!added.stored) throw new Error(added.reason);
		const stage = composeDevices({ dataDir, ambient: fakeAmbient(), relayToHost: noHost, deviceStore });
		try {
			await stage.console({
				kind: "device_reading_post",
				id: SENSOR_MAC,
				advert: { name: "GVH5110_3C5D", data: { "1": "010103bac864" }, services: ["ec88"] },
				at: 1,
			});
			const answer = await stage.console({ kind: "device_read", id: SENSOR_MAC });
			expect(answer).toMatchObject({
				kind: "sensor",
				readings: [],
				payloads: [
					{
						at: 1,
						radio: "phones",
						name: "GVH5110_3C5D",
						data: { "1": "010103bac864" },
						services: ["ec88"],
					},
				],
			});
			expect(answer).not.toHaveProperty("model");
		} finally {
			await stage.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
