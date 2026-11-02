import { describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "../gateway/devices/kasa/codec.js";
import { createKasaScanner, type KasaInterfaceList, type KasaUdpSocket } from "../mcp/devcontainer/kasaScan.js";
import type { TimerHandle } from "../shared/ambient.js";

interface SentPacket {
	message: Uint8Array;
	port: number;
	address: string;
}

class MemoryUdpSocket implements KasaUdpSocket {
	readonly sent: SentPacket[] = [];
	closed = false;
	private readonly messageListeners: Array<(message: Uint8Array, remote: { address: string }) => void> = [];
	private readonly errorListeners: Array<(error: Error) => void> = [];
	private readonly listeningListeners: Array<() => void> = [];
	private readonly bindError: boolean;
	private readonly failSend: string | undefined;

	constructor(options: { bindError?: boolean; failSend?: string } = {}) {
		this.bindError = options.bindError ?? false;
		this.failSend = options.failSend;
	}

	on(event: "message", listener: (message: Uint8Array, remote: { address: string }) => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	on(
		event: "message" | "error",
		listener: ((message: Uint8Array, remote: { address: string }) => void) | ((error: Error) => void),
	): void {
		if (event === "message") {
			this.messageListeners.push(listener as (message: Uint8Array, remote: { address: string }) => void);
		} else this.errorListeners.push(listener as (error: Error) => void);
	}

	once(event: "listening", listener: () => void): void {
		if (event === "listening") this.listeningListeners.push(listener);
	}

	bind(): void {
		if (this.bindError) {
			for (const listener of this.errorListeners) listener(new Error("bind failed"));
			return;
		}
		for (const listener of this.listeningListeners) listener();
	}

	setBroadcast(): void {}

	send(message: Uint8Array, port: number, address: string, callback: (error: Error | null) => void): void {
		this.sent.push({ message, port, address });
		callback(address === this.failSend ? new Error("send failed") : null);
	}

	close(): void {
		this.closed = true;
	}

	reply(message: Uint8Array, address: string): void {
		for (const listener of this.messageListeners) listener(message, { address });
	}
}

function fakeClock() {
	let pending: (() => void) | undefined;
	let scheduledMs = 0;
	const handle = {} as TimerHandle;
	return {
		clock: {
			setTimer: vi.fn((run: () => void, ms: number) => {
				pending = run;
				scheduledMs = ms;
				return handle;
			}),
			clearTimer: vi.fn(() => {
				pending = undefined;
			}),
		},
		fire: () => {
			const run = pending;
			pending = undefined;
			run?.();
		},
		scheduledMs: () => scheduledMs,
	};
}

const interfaces: KasaInterfaceList = {
	lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
	wlan0: [{ address: "192.168.1.34", netmask: "255.255.255.0", family: "IPv4", internal: false }],
	eth0: [{ address: "10.4.12.8", netmask: "255.255.0.0", family: "IPv4", internal: false }],
};

function sysinfo(mac: string, alias: string) {
	return encrypt(
		JSON.stringify({
			system: {
				get_sysinfo: {
					alias,
					model: "HS103(US)",
					hw_ver: "3.0",
					sw_ver: "1.0.3",
					mac,
				},
			},
		}),
	);
}

describe("Kasa discovery scan", () => {
	it("broadcasts legacy discovery and returns valid unique replies", async () => {
		const socket = new MemoryUdpSocket();
		const clock = fakeClock();
		const scan = createKasaScanner({
			interfaces: () => interfaces,
			socketFactory: () => socket,
			clock: clock.clock,
		});
		const result = scan();

		expect(socket.sent).toHaveLength(2);
		expect(socket.sent.map(({ port, address }) => ({ port, address }))).toEqual([
			{ port: 9999, address: "192.168.1.255" },
			{ port: 9999, address: "10.4.255.255" },
		]);
		expect(decrypt(socket.sent[0]!.message)).toBe(JSON.stringify({ system: { get_sysinfo: {} } }));
		expect(clock.scheduledMs()).toBe(4_000);
		socket.reply(sysinfo("AA:BB:CC:DD:EE:FF", "Desk lamp"), "192.168.1.80");
		socket.reply(sysinfo("11:22:33:44:55:66", "Fan"), "192.168.1.81");
		socket.reply(encrypt("not json"), "192.168.1.82");
		socket.reply(sysinfo("aa:bb:cc:dd:ee:ff", "Duplicate"), "192.168.1.83");
		clock.fire();

		expect(await result).toEqual({
			candidates: [
				{
					mac: "aa:bb:cc:dd:ee:ff",
					address: "192.168.1.80",
					alias: "Desk lamp",
					model: "HS103(US)",
					hardware: "3.0",
					firmware: "1.0.3",
				},
				{
					mac: "11:22:33:44:55:66",
					address: "192.168.1.81",
					alias: "Fan",
					model: "HS103(US)",
					hardware: "3.0",
					firmware: "1.0.3",
				},
			],
		});
		expect(socket.closed).toBe(true);
	});

	it("caps valid unique devices at the shared device limit", async () => {
		const socket = new MemoryUdpSocket();
		const clock = fakeClock();
		const scan = createKasaScanner({
			interfaces: () => interfaces,
			socketFactory: () => socket,
			clock: clock.clock,
		});
		const result = scan();

		for (let index = 0; index < 70; index += 1) {
			const suffix = index.toString(16).padStart(2, "0");
			socket.reply(sysinfo(`02:00:00:00:00:${suffix}`, `Plug ${index}`), `192.168.1.${index + 2}`);
		}
		clock.fire();

		const scanned = await result;
		expect("candidates" in scanned ? scanned.candidates : []).toHaveLength(64);
	});

	it("drops oversized datagrams and continues scanning", async () => {
		const socket = new MemoryUdpSocket();
		const clock = fakeClock();
		const scan = createKasaScanner({
			interfaces: () => interfaces,
			socketFactory: () => socket,
			clock: clock.clock,
		});
		const result = scan();
		const oversized = encrypt(
			`${JSON.stringify({
				system: {
					get_sysinfo: {
						alias: "Ignored",
						model: "HS103(US)",
						hw_ver: "3.0",
						sw_ver: "1.0.3",
						mac: "aa:bb:cc:dd:ee:ff",
					},
				},
			}).slice(0, -1)}${" ".repeat(4097)}}`,
		);

		expect(oversized.byteLength).toBeGreaterThan(4096);
		socket.reply(oversized, "192.168.1.80");
		socket.reply(sysinfo("11:22:33:44:55:66", "Fan"), "192.168.1.81");
		clock.fire();

		expect(await result).toMatchObject({ candidates: [{ mac: "11:22:33:44:55:66", alias: "Fan" }] });
		expect(socket.closed).toBe(true);
	});

	it("closes after processing 1024 datagrams", async () => {
		const socket = new MemoryUdpSocket();
		const scan = createKasaScanner({
			interfaces: () => interfaces,
			socketFactory: () => socket,
			clock: fakeClock().clock,
		});
		const result = scan();
		const invalid = encrypt("not json");
		for (let index = 0; index < 1023; index += 1) socket.reply(invalid, "192.168.1.80");
		socket.reply(sysinfo("aa:bb:cc:dd:ee:ff", "Last allowed"), "192.168.1.81");
		socket.reply(sysinfo("11:22:33:44:55:66", "Over limit"), "192.168.1.82");

		expect(await result).toMatchObject({ candidates: [{ mac: "aa:bb:cc:dd:ee:ff", alias: "Last allowed" }] });
		expect(socket.closed).toBe(true);
	});

	it("keeps scanning when one broadcast send fails", async () => {
		const socket = new MemoryUdpSocket({ failSend: "192.168.1.255" });
		const clock = fakeClock();
		const scan = createKasaScanner({
			interfaces: () => interfaces,
			socketFactory: () => socket,
			clock: clock.clock,
		});
		const result = scan();
		socket.reply(sysinfo("11:22:33:44:55:66", "Fan"), "10.4.0.9");
		clock.fire();

		expect(await result).toMatchObject({ candidates: [{ mac: "11:22:33:44:55:66", address: "10.4.0.9" }] });
	});

	it("refuses when no non-loopback IPv4 interface can broadcast", async () => {
		const socketFactory = vi.fn(() => new MemoryUdpSocket());
		const scan = createKasaScanner({
			interfaces: () => ({
				lo: interfaces.lo,
				wlan0: [{ ...interfaces.wlan0![0]!, internal: true }],
				tun0: [{ address: "10.8.0.2", netmask: "255.255.255.255", family: "IPv4", internal: false }],
				ppp0: [{ address: "10.9.0.2", netmask: "255.255.255.254", family: "IPv4", internal: false }],
			}),
			socketFactory,
			clock: fakeClock().clock,
		});

		expect(await scan()).toEqual({ reason: "no_interface" });
		expect(socketFactory).not.toHaveBeenCalled();
	});

	it("refuses when the UDP socket cannot bind", async () => {
		const socket = new MemoryUdpSocket({ bindError: true });
		const clock = fakeClock();
		const scan = createKasaScanner({
			interfaces: () => interfaces,
			socketFactory: () => socket,
			clock: clock.clock,
		});

		expect(await scan()).toEqual({ reason: "socket" });
		expect(socket.closed).toBe(true);
	});

	it("returns an empty successful scan when the reply window closes", async () => {
		const socket = new MemoryUdpSocket();
		const clock = fakeClock();
		const scan = createKasaScanner({
			interfaces: () => interfaces,
			socketFactory: () => socket,
			clock: clock.clock,
		});
		const result = scan();
		clock.fire();

		expect(await result).toEqual({ candidates: [] });
		expect(socket.closed).toBe(true);
	});
});
