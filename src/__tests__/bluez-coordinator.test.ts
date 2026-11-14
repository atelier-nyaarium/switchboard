import { describe, expect, it, vi } from "vitest";
import { type BluezClock, createBluezCoordinator } from "../mcp/devcontainer/bluetooth/bluez.js";
import { DbusClient, type DbusTransport } from "../mcp/devcontainer/bluetooth/dbusClient.js";
import {
	type DbusMessage,
	type DbusValue,
	decodeMessage,
	encodeMessage,
	messageLength,
} from "../mcp/devcontainer/bluetooth/dbusWire.js";
import { createDeviceWatchController } from "../mcp/devcontainer/bluetooth/deviceWatch.js";

const ADAPTER = "/org/bluez/hci0";
const MAC = "ce:1c:44:06:3c:5d";
const DEVICE_PATH = `/org/bluez/hci0/dev_${MAC.replaceAll(":", "_").toUpperCase()}`;

async function settle(): Promise<void> {
	for (let index = 0; index < 40; index++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 20; index++) {
		await settle();
		if (predicate()) return;
	}
	throw new Error("fake bus did not reach expected call");
}

class FakeClock implements BluezClock {
	nowMs = 0;
	private next = 1;
	private timers = new Map<number, { at: number; callback: () => void }>();

	now(): number {
		return this.nowMs;
	}

	schedule(delayMs: number, callback: () => void): () => void {
		const id = this.next++;
		this.timers.set(id, { at: this.nowMs + delayMs, callback });
		return () => this.timers.delete(id);
	}

	get pending(): number {
		return this.timers.size;
	}

	async advance(delayMs: number): Promise<void> {
		const end = this.nowMs + delayMs;
		while (true) {
			const next = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= end)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (!next) break;
			this.nowMs = next[1].at;
			this.timers.delete(next[0]);
			next[1].callback();
			await settle();
		}
		this.nowMs = end;
		await settle();
	}
}

function variant(signature: string, value: DbusValue) {
	return { signature, value };
}

function props(address: string, rssi = -55): Map<string, DbusValue> {
	return new Map([
		["Address", variant("s", address.toUpperCase())],
		["Name", variant("s", "Beacon")],
		["RSSI", variant("n", rssi)],
		["ManufacturerData", variant("a{qv}", new Map([[1, variant("ay", Uint8Array.of(1, 2, 3))]]))],
		["UUIDs", variant("as", ["0000ec88-0000-1000-8000-00805f9b34fb"])],
	]);
}

function managedObjects(
	options: { noAdapter?: boolean; devices?: number; powered?: boolean } = {},
): Map<string, DbusValue> {
	const objects = new Map<string, DbusValue>();
	if (!options.noAdapter) {
		objects.set(
			ADAPTER,
			new Map([["org.bluez.Adapter1", new Map([["Powered", variant("b", options.powered ?? true)]])]]),
		);
	}
	for (let index = 0; index < (options.devices ?? 1); index++) {
		const suffix = (0x3c5d + index).toString(16).padStart(4, "0");
		const address = `ce:1c:44:06:${suffix.slice(0, 2)}:${suffix.slice(2)}`;
		const path = `/org/bluez/hci0/dev_${address.replaceAll(":", "_").toUpperCase()}`;
		objects.set(path, new Map([["org.bluez.Device1", props(address, -40 - (index % 80))]]));
	}
	return objects;
}

class FakeTransport implements DbusTransport {
	private byteListeners = new Set<(bytes: Uint8Array) => void>();
	private closeListeners = new Set<(error?: Error) => void>();
	private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
	private serverSerial = 1;
	private closed = false;
	private deferred: Array<() => void> = [];
	private readonly decoder = new TextDecoder();
	readonly calls: DbusMessage[] = [];
	readonly matchRules: string[] = [];
	readonly filters: Map<DbusValue, DbusValue>[] = [];
	startCount = 0;
	stopCount = 0;
	deferStart = false;
	ignoreStop = false;
	deferConnect: (() => void) | null = null;
	connectStarted: (() => void) | null = null;
	noAdapter = false;
	deviceCount = 1;
	powered = true;
	busUnavailable = false;
	startInProgress = false;
	powerOnWithManagedReply = false;

	async connect(): Promise<void> {
		this.connectStarted?.();
		if (this.busUnavailable) throw new Error("no system bus");
		if (this.deferConnect) await new Promise<void>((resolve) => (this.deferConnect = resolve));
	}

	write(bytes: Uint8Array): void {
		if (this.closed) throw new Error("closed");
		if (bytes.length && (bytes[0] === 0 || (bytes[0] >= 65 && bytes[0] <= 90))) {
			const text = this.decoder.decode(bytes[0] === 0 ? bytes.subarray(1) : bytes);
			if (text.startsWith("AUTH EXTERNAL ")) this.emit(new TextEncoder().encode("OK 0123456789abcdef\r\n"));
			return;
		}
		this.buffer = join(this.buffer, bytes);
		while (true) {
			const length = messageLength(this.buffer);
			if (length === null) return;
			const message = decodeMessage(this.buffer.subarray(0, length));
			this.buffer = this.buffer.slice(length);
			this.handle(message);
		}
	}

	onBytes(listener: (bytes: Uint8Array) => void): () => void {
		this.byteListeners.add(listener);
		return () => this.byteListeners.delete(listener);
	}

	onClose(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const listener of this.closeListeners) listener(new Error("closed"));
	}

	releaseConnect(): void {
		const release = this.deferConnect;
		this.deferConnect = null;
		release?.();
	}

	releaseStarts(): void {
		for (const release of this.deferred.splice(0)) release();
	}

	signal(message: Omit<DbusMessage, "type" | "serial">): void {
		this.emit(
			encodeMessage({
				type: "signal",
				serial: this.serverSerial++,
				...message,
			}),
		);
	}

	private handle(message: DbusMessage): void {
		if (message.type !== "method_call") return;
		this.calls.push(message);
		const member = message.member;
		if (member === "AddMatch") this.matchRules.push(String(message.body?.[0]));
		if (member === "SetDiscoveryFilter" && message.body?.[0] instanceof Map)
			this.filters.push(message.body[0] as Map<DbusValue, DbusValue>);
		if (member === "StartDiscovery") this.startCount++;
		if (member === "StopDiscovery") this.stopCount++;
		if (member === "StartDiscovery" && this.startInProgress) {
			this.startInProgress = false;
			this.replyError(message, "org.bluez.Error.InProgress", "In progress");
			return;
		}
		if (member === "StopDiscovery" && this.ignoreStop) return;
		if (member === "StartDiscovery" && this.deferStart) {
			this.deferred.push(() => this.reply(message));
			return;
		}
		if (member === "Hello") {
			this.reply(message, [":1.7"], "s");
			return;
		}
		if (member === "GetManagedObjects") {
			const powerSignal = this.powerOnWithManagedReply
				? encodeMessage({
						type: "signal",
						serial: this.serverSerial++,
						path: ADAPTER,
						interface: "org.freedesktop.DBus.Properties",
						member: "PropertiesChanged",
						bodySignature: "sa{sv}as",
						body: ["org.bluez.Adapter1", new Map([["Powered", variant("b", true)]]), []],
					})
				: undefined;
			this.reply(
				message,
				[managedObjects({ noAdapter: this.noAdapter, powered: this.powered, devices: this.deviceCount })],
				"a{oa{sa{sv}}}",
				powerSignal,
			);
			return;
		}
		this.reply(message);
	}

	private reply(call: DbusMessage, body?: DbusValue[], bodySignature?: string, trailing?: Uint8Array): void {
		const response = encodeMessage({
			type: "method_return",
			serial: this.serverSerial++,
			replySerial: call.serial,
			body,
			bodySignature,
		});
		this.emit(trailing ? join(response, trailing) : response);
	}

	private replyError(call: DbusMessage, errorName: string, message: string): void {
		this.emit(
			encodeMessage({
				type: "error",
				serial: this.serverSerial++,
				replySerial: call.serial,
				errorName,
				bodySignature: "s",
				body: [message],
			}),
		);
	}

	private emit(bytes: Uint8Array): void {
		for (const listener of this.byteListeners) listener(bytes);
	}
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
	const result = new Uint8Array(left.length + right.length);
	result.set(left);
	result.set(right, left.length);
	return result;
}

function setup(
	options: {
		noAdapter?: boolean;
		devices?: number;
		busUnavailable?: boolean;
		powered?: boolean;
		powerOnWithManagedReply?: boolean;
	} = {},
) {
	const clock = new FakeClock();
	const buses: FakeTransport[] = [];
	const coordinator = createBluezCoordinator({
		clock,
		clientFactory: () => {
			const bus = new FakeTransport();
			bus.noAdapter = options.noAdapter ?? false;
			bus.deviceCount = options.devices ?? 1;
			bus.busUnavailable = options.busUnavailable ?? false;
			bus.powered = options.powered ?? true;
			bus.powerOnWithManagedReply = options.powerOnWithManagedReply ?? false;
			buses.push(bus);
			return new DbusClient(bus);
		},
	});
	return { clock, buses, coordinator };
}

async function ready(hold: ReturnType<ReturnType<typeof setup>["coordinator"]["hold"]>) {
	const result = hold.ready(2_000);
	await settle();
	return result;
}

describe("BlueZ coordinator", () => {
	it("unions filters and joins the running scan with cached devices", async () => {
		const { clock, buses, coordinator } = setup();
		const first = coordinator.hold({ DuplicateData: variant("b", true) });
		expect(await ready(first)).toBe("discovering");
		expect(buses[0].matchRules).toHaveLength(5);
		expect(buses[0].filters[0].get("Transport")).toEqual(variant("s", "le"));
		expect(buses[0].startCount).toBe(1);

		const scan = coordinator.scan(100);
		await settle();
		first.release();
		await settle();
		expect(buses[0].stopCount).toBe(0);
		await clock.advance(100);
		expect(await scan).toMatchObject({
			devices: [{ mac: MAC, name: "Beacon", signal: -40, data: { "1": "010203" }, services: ["ec88"] }],
		});
		await settle();
		expect(buses[0].stopCount).toBe(1);
		coordinator.close();
	});

	it("merges added and changed advertisements for one address", async () => {
		const { buses, coordinator } = setup({ devices: 0 });
		const hold = coordinator.hold();
		expect(await ready(hold)).toBe("discovering");
		const seen: unknown[] = [];
		coordinator.onObservation((item) => seen.push(item));
		const address = "aa:bb:cc:dd:ee:ff";
		const path = `/org/bluez/hci0/dev_${address.replaceAll(":", "_").toUpperCase()}`;
		buses[0].signal({
			path: "/",
			interface: "org.freedesktop.DBus.ObjectManager",
			member: "InterfacesAdded",
			bodySignature: "oa{sa{sv}}",
			body: [path, new Map([["org.bluez.Device1", props(address, -62)]])],
		});
		buses[0].signal({
			path,
			interface: "org.freedesktop.DBus.Properties",
			member: "PropertiesChanged",
			bodySignature: "sa{sv}as",
			body: ["org.bluez.Device1", new Map([["RSSI", variant("n", -48)]]), []],
		});
		expect(seen).toHaveLength(2);
		expect(seen[1]).toMatchObject({ mac: address, signal: -48, advert: { name: "Beacon" } });
		hold.release();
		await settle();
		coordinator.close();
	});

	it("caps the joined cache at 256 addresses", async () => {
		const { clock, coordinator } = setup({ devices: 257 });
		const hold = coordinator.hold();
		expect(await ready(hold)).toBe("discovering");
		const scan = coordinator.scan(10);
		await settle();
		await clock.advance(10);
		const result = await scan;
		if (!("devices" in result)) throw new Error("scan did not return devices");
		expect(result.devices).toHaveLength(256);
		expect(result.devices.some((device) => device.mac === MAC)).toBe(false);
		hold.release();
		await settle();
		coordinator.close();
	});

	it("observes evicted devices by path and removes them", async () => {
		const { clock, buses, coordinator } = setup({ devices: 0 });
		const hold = coordinator.hold();
		expect(await ready(hold)).toBe("discovering");
		const seen: Array<{ mac: string; signal: number }> = [];
		coordinator.onObservation(({ mac, signal }) => seen.push({ mac, signal }));
		const targetPath = DEVICE_PATH;
		const add = (path: string, address: string, rssi: number) =>
			buses[0].signal({
				path: "/",
				interface: "org.freedesktop.DBus.ObjectManager",
				member: "InterfacesAdded",
				bodySignature: "oa{sa{sv}}",
				body: [path, new Map([["org.bluez.Device1", props(address, rssi)]])],
			});
		add(targetPath, MAC, -60);
		for (let index = 0; index < 256; index++) {
			const address = `aa:bb:cc:dd:${Math.floor(index / 256)
				.toString(16)
				.padStart(2, "0")}:${index.toString(16).padStart(2, "0")}`;
			add(`/org/bluez/hci0/dev_${address.replaceAll(":", "_").toUpperCase()}`, address, -50);
		}
		buses[0].signal({
			path: targetPath,
			interface: "org.freedesktop.DBus.Properties",
			member: "PropertiesChanged",
			bodySignature: "sa{sv}as",
			body: ["org.bluez.Device1", new Map([["RSSI", variant("n", -35)]]), []],
		});
		expect(seen.at(-1)).toEqual({ mac: MAC, signal: -35 });
		add(targetPath, MAC, -30);
		buses[0].signal({
			path: "/",
			interface: "org.freedesktop.DBus.ObjectManager",
			member: "InterfacesRemoved",
			bodySignature: "oas",
			body: [targetPath, ["org.bluez.Device1"]],
		});
		const scan = coordinator.scan(1);
		await settle();
		await clock.advance(1);
		const result = await scan;
		if (!("devices" in result)) throw new Error("scan did not return devices");
		expect(result.devices.some((device) => device.mac === MAC)).toBe(false);
		hold.release();
		await settle();
		coordinator.close();
	});

	it("returns no_radio without an adapter or a system bus", async () => {
		for (const option of [{ noAdapter: true }, { busUnavailable: true }]) {
			const { coordinator } = setup(option);
			const hold = coordinator.hold();
			expect(await ready(hold)).toBe("no_radio");
			hold.release();
			coordinator.close();
		}
	});

	it("treats InProgress as active discovery", async () => {
		const bus = new FakeTransport();
		bus.startInProgress = true;
		const active = createBluezCoordinator({ clientFactory: () => new DbusClient(bus) });
		const hold = active.hold();
		expect(await ready(hold)).toBe("discovering");
		hold.update({ DuplicateData: variant("b", true) });
		await settle();
		expect(bus.startCount).toBe(1);
		hold.release();
		active.close();
	});

	it("retries owner changes with increasing delays", async () => {
		const { clock, buses, coordinator } = setup();
		const hold = coordinator.hold();
		expect(await ready(hold)).toBe("discovering");
		for (const delay of [250, 500, 1_000]) {
			await clock.advance(3_000);
			buses.at(-1)?.signal({
				path: "/org/freedesktop/DBus",
				interface: "org.freedesktop.DBus",
				member: "NameOwnerChanged",
				bodySignature: "sss",
				body: ["org.bluez", ":1.2", ""],
			});
			await settle();
			const before = buses.length;
			await clock.advance(delay - 1);
			expect(buses).toHaveLength(before);
			await clock.advance(1);
			await settle();
			expect(buses).toHaveLength(before + 1);
			expect(buses.at(-1)?.startCount).toBe(1);
		}
		hold.release();
		coordinator.close();
	});

	it("reconnects after the held adapter is removed", async () => {
		const { clock, buses, coordinator } = setup();
		const hold = coordinator.hold();
		expect(await ready(hold)).toBe("discovering");
		buses[0].signal({
			path: "/",
			interface: "org.freedesktop.DBus.ObjectManager",
			member: "InterfacesRemoved",
			bodySignature: "oas",
			body: [ADAPTER, ["org.bluez.Adapter1"]],
		});
		await settle();
		expect(buses).toHaveLength(1);
		await clock.advance(250);
		expect(buses).toHaveLength(2);
		expect(buses[1].startCount).toBe(1);
		hold.release();
		coordinator.close();
	});

	it("starts again after a timed out stop", async () => {
		vi.useFakeTimers();
		try {
			const { clock, buses, coordinator } = setup();
			const first = coordinator.hold();
			expect(await ready(first)).toBe("discovering");
			buses[0].ignoreStop = true;
			first.release();
			await settle();
			expect(buses[0].stopCount).toBe(1);
			await vi.advanceTimersByTimeAsync(1_001);
			await settle();
			const second = coordinator.hold();
			const secondReady = second.ready(2_000);
			await clock.advance(250);
			expect(await secondReady).toBe("discovering");
			expect(buses[0].startCount).toBe(2);
			second.release();
			coordinator.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("backs off a persistent watch without a radio", async () => {
		const { clock, buses, coordinator } = setup({ noAdapter: true });
		const sent: unknown[] = [];
		const watch = createDeviceWatchController(coordinator, (frame) => sent.push(frame));
		expect(watch.replace({ type: "device_watch", watch: [{ mac: MAC, activeScan: false }] })).toBe(true);
		await settle();
		expect(buses).toHaveLength(1);
		for (const [delay, expected] of [
			[250, 2],
			[500, 3],
			[1_000, 4],
		] as const) {
			await clock.advance(delay - 1);
			expect(buses).toHaveLength(expected - 1);
			await clock.advance(1);
			await settle();
			expect(buses).toHaveLength(expected);
		}
		watch.close();
		coordinator.close();
		expect(sent).toEqual([]);
	});

	it("updates one watch hold and releases it when empty", async () => {
		const { buses, coordinator } = setup({ devices: 0 });
		const watch = createDeviceWatchController(coordinator, () => {});
		watch.replace({ type: "device_watch", watch: [{ mac: MAC, activeScan: false }] });
		await waitFor(() => buses[0]?.startCount === 1);
		expect(buses[0].startCount).toBe(1);
		watch.replace({ type: "device_watch", watch: [{ mac: MAC, activeScan: true }] });
		await waitFor(() => buses[0]?.filters.length === 2);
		expect(buses[0].filters).toHaveLength(2);
		expect(buses[0].filters[1].get("DuplicateData")).toEqual(variant("b", true));
		watch.replace({ type: "device_watch", watch: [] });
		await waitFor(() => buses[0]?.stopCount === 1);
		expect(buses[0].stopCount).toBe(1);
		watch.close();
		coordinator.close();
	});

	it("ignores a late start reply from the old owner epoch", async () => {
		const clock = new FakeClock();
		const buses: FakeTransport[] = [];
		const coordinator = createBluezCoordinator({
			clock,
			clientFactory: () => {
				const bus = new FakeTransport();
				bus.deferStart = buses.length === 0;
				buses.push(bus);
				return new DbusClient(bus);
			},
		});
		const hold = coordinator.hold();
		await settle();
		const firstBus = buses[0];
		expect(firstBus).toBeDefined();
		const startWait = hold.ready(5_000);
		firstBus!.signal({
			path: "/org/freedesktop/DBus",
			interface: "org.freedesktop.DBus",
			member: "NameOwnerChanged",
			bodySignature: "sss",
			body: ["org.bluez", ":1.3", ""],
		});
		firstBus!.releaseStarts();
		await settle();
		await clock.advance(250);
		await settle();
		expect(buses[1]?.startCount).toBe(1);
		expect(await startWait).toBe("discovering");
		hold.release();
		coordinator.close();
	});

	it("waits while powered off and reapplies on power", async () => {
		const { clock, buses, coordinator } = setup();
		const hold = coordinator.hold({ DuplicateData: variant("b", true) });
		expect(await ready(hold)).toBe("discovering");
		const before = buses[0].calls.length;
		buses[0].signal({
			path: ADAPTER,
			interface: "org.freedesktop.DBus.Properties",
			member: "PropertiesChanged",
			bodySignature: "sa{sv}as",
			body: ["org.bluez.Adapter1", new Map([["Powered", variant("b", false)]]), []],
		});
		await settle();
		await clock.advance(10_000);
		expect(buses[0].calls).toHaveLength(before);
		buses[0].signal({
			path: ADAPTER,
			interface: "org.freedesktop.DBus.Properties",
			member: "PropertiesChanged",
			bodySignature: "sa{sv}as",
			body: ["org.bluez.Adapter1", new Map([["Powered", variant("b", true)]]), []],
		});
		await settle();
		expect(buses[0].filters).toHaveLength(2);
		expect(buses[0].startCount).toBe(2);
		hold.release();
		coordinator.close();
	});

	it("replays power signals following the managed objects reply", async () => {
		const { buses, coordinator } = setup({ powered: false, powerOnWithManagedReply: true });
		const hold = coordinator.hold();
		const readiness = hold.ready(2_000);
		await waitFor(() => buses[0]?.startCount === 1);
		expect(buses[0].startCount).toBe(1);
		expect(await readiness).toBe("discovering");
		hold.release();
		coordinator.close();
	});

	it("coalesces filter updates during connection", async () => {
		const bus = new FakeTransport();
		bus.deferConnect = () => {};
		const coordinator = createBluezCoordinator({ clientFactory: () => new DbusClient(bus) });
		let began!: () => void;
		const started = new Promise<void>((resolve) => (began = resolve));
		bus.connectStarted = began;
		const first = coordinator.hold();
		const second = coordinator.hold({ DuplicateData: variant("b", false) });
		first.update({ RSSI: variant("n", -70) });
		second.update({ DuplicateData: variant("b", true) });
		await started;
		bus.releaseConnect();
		expect(await ready(first)).toBe("discovering");
		expect(bus.calls.filter((call) => call.member === "SetDiscoveryFilter")).toHaveLength(1);
		expect(bus.filters[0].get("RSSI")).toEqual(variant("n", -70));
		expect(bus.filters[0].get("DuplicateData")).toEqual(variant("b", true));
		first.release();
		second.release();
		coordinator.close();
	});

	it("closes during connection without leaving timers", async () => {
		const clock = new FakeClock();
		const bus = new FakeTransport();
		let began!: () => void;
		const started = new Promise<void>((resolve) => (began = resolve));
		bus.connectStarted = began;
		bus.deferConnect = () => {};
		const coordinator = createBluezCoordinator({ clock, clientFactory: () => new DbusClient(bus) });
		const hold = coordinator.hold();
		const readiness = hold.ready(2_000);
		await started;
		coordinator.close();
		expect(await readiness).toBe("failed");
		bus.releaseConnect();
		await settle();
		expect(bus.calls).toEqual([]);
		expect(clock.pending).toBe(0);
	});
});
