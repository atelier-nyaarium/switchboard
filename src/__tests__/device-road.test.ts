import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { composeDevices, DEVICE_IDENTIFY_WAIT_MS, DEVICE_READ_WAIT_MS } from "../gateway/compose/composeDevices.js";
import { createKasaTransport, type KasaTransport } from "../gateway/devices/kasa/transport.js";
import { createDeviceRoad, Decline, TOGGLE_DOUBT } from "../gateway/devices/road.js";
import { addShape, NOT_STARTED, readShape } from "../gateway/devices/shapes.js";
import { CONSOLE_ANSWER_WAIT_MS, CONSOLE_HOP_MARGIN_MS } from "../shared/console-protocol.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { createFakeKasaPlug } from "../testing/fakeKasaPlug.js";

const MAC = "aa:bb:cc:dd:ee:ff";
const CONSOLE_BOUND_MS = CONSOLE_ANSWER_WAIT_MS - CONSOLE_HOP_MARGIN_MS;

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
			await stage.console.add({ mac: MAC, address: "127.0.0.1", name: "Lamp" });
			expect(await stage.console.set(MAC, "toggle")).toMatchObject({ reason: "timeout" });
			expect(await stage.console.set(MAC, "toggle")).toEqual({ reason: "refused", detail: TOGGLE_DOUBT });
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
			await stage.console.add({ mac: MAC, address: "127.0.0.1", name: "Lamp" });
			expect(await stage.console.set(MAC, "toggle")).toEqual({ reason: "timeout", detail: NOT_STARTED });
			expect(await stage.console.set(MAC, "toggle")).toMatchObject({ state: { state: "on" } });
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
			await road.onSlot("console", addShape, MAC, async (slot) => {
				await slot.identify("127.0.0.1", MAC);
				return slot.write.add({ mac: MAC, address: "127.0.0.1", name: "Lamp" });
			});
			const answer = await road.operation("console", readShape, async (op) => {
				void op.plug(MAC, (plug) => plug.drive((ctx) => plug.driver.read(plug.record, ctx)));
				await plug.waitForHeldReply();
				throw new Error("left behind");
			});
			expect(answer).toMatchObject({ reason: "unreachable" });
			expect(
				await road.onDevice("console", readShape, MAC, async (plug) => {
					const read = await plug.drive((ctx) => plug.driver.read(plug.record, ctx));
					return { state: read.state, schedule: read.schedule };
				}),
			).toMatchObject({ state: { state: "off" } });
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
			await stage.console.add({ mac: MAC, address: "127.0.0.1", name: "Lamp" });
			const setting = stage.console.set(MAC, "on");
			let setSettled = false;
			void setting.then(() => {
				setSettled = true;
			});
			await plug.waitForHeldReply();
			const listing = stage.listDevices();
			await ambient.advance(DEVICE_READ_WAIT_MS);
			expect(await listing).toEqual({
				kind: "ok",
				answer: { devices: [{ id: MAC, name: "Lamp", kind: "switch", state: "unknown" }] },
			});
			expect(setSettled).toBe(false);
			await ambient.advance(CONSOLE_BOUND_MS);
			expect(await setting).toMatchObject({ reason: "timeout" });
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
			const scanning = stage.console.scan();
			await stage.close();
			expect(await scanning).toEqual({ reason: "timeout", detail: NOT_STARTED });
		} finally {
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("declines every entry after close", async () => {
		const dataDir = fresh("fence");
		const plug = await createFakeKasaPlug({ mac: MAC });
		const relay = vi.fn(noHost);
		const stage = composeDevices({
			dataDir,
			ambient: fakeAmbient(),
			transport: createKasaTransport(plug.port),
			relayToHost: relay,
		});
		try {
			await stage.console.add({ mac: MAC, address: "127.0.0.1", name: "Lamp" });
			await stage.close();
			const commandsAfterClose = plug.received().length;
			const schedule = { enabled: true, rules: [] };
			const entries: Record<string, () => Promise<unknown>> = {
				list: () => stage.console.list(),
				read: () => stage.console.read(MAC),
				scan: () => stage.console.scan(),
				add: () => stage.console.add({ mac: "aa:bb:cc:dd:ee:01", address: "127.0.0.1", name: "Fan" }),
				rename: () => stage.console.rename(MAC, "Desk lamp", 1),
				remove: () => stage.console.remove(MAC, 1),
				set: () => stage.console.set(MAC, "on"),
				schedulePut: () => stage.console.schedulePut(MAC, 1, schedule),
				settingPut: () =>
					stage.console.settingPut(MAC, 1, { driver: "kasa", setting: { key: "led", value: false } }),
				listDevices: () => stage.listDevices(),
				setDevice: () => stage.setDevice(MAC, "on"),
			};
			expect(Object.keys(stage.console).every((name) => name in entries)).toBe(true);
			for (const [name, call] of Object.entries(entries)) {
				expect({ name, answer: await call() }).toMatchObject({ name, answer: { detail: NOT_STARTED } });
			}
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
			await road.onSlot("console", addShape, MAC, async (slot) => {
				await slot.identify("127.0.0.1", MAC);
				return slot.write.add({ mac: MAC, address: "127.0.0.1", name: "Lamp" });
			});
			const answer = await road.operation("console", readShape, async (op) => {
				const outcome = await op.plug(MAC, async (plug) => {
					await expect(op.plug(MAC, async () => ({}))).rejects.toThrow();
					const read = await plug.drive((ctx) => plug.driver.read(plug.record, ctx));
					return { state: read.state, schedule: read.schedule };
				});
				if (!outcome.ok) throw new Decline(outcome.why);
				return outcome.value;
			});
			expect(answer).toMatchObject({ state: { state: "off" } });
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
			await stage.console.add({ mac: MAC, address: "10.0.0.1", name: "Lamp" });
			expect(await stage.console.scan()).toMatchObject({ candidates: [{ address: "10.0.0.2" }] });
			expect(await stage.console.list()).toMatchObject({
				records: [{ id: MAC, address: "10.0.0.2", revision: 2 }],
			});
		} finally {
			await stage.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
