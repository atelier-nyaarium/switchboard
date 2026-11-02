import type { RemoteInfo } from "node:dgram";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { decrypt, encrypt } from "../../gateway/devices/kasa/codec.js";
import { type Ambient, processAmbient, type TimerHandle } from "../../shared/ambient.js";
import { type HostKasaScanResult, HostKasaScanResultSchema } from "../../shared/host-op.js";
import {
	DEVICE_MAX_RECORDS,
	DeviceAddressSchema,
	DeviceCandidateSchema,
	normalizeDeviceMac,
} from "../../shared/schemasDevices.js";

const DISCOVERY_PORT = 9999;
const SCAN_WINDOW_MS = 4_000;
const MAX_SCAN_DATAGRAM_BYTES = 4096;
const MAX_SCAN_DATAGRAMS = 1024;
const DISCOVERY_REQUEST = encrypt(JSON.stringify({ system: { get_sysinfo: {} } }));

export interface KasaNetworkInterface {
	address: string;
	netmask: string;
	family: string | number;
	internal: boolean;
}

export type KasaInterfaceList = Record<string, readonly KasaNetworkInterface[] | undefined>;

export interface KasaUdpSocket {
	on(event: "message", listener: (message: Uint8Array, remote: Pick<RemoteInfo, "address">) => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	once(event: "listening", listener: () => void): void;
	bind(port: number): void;
	setBroadcast(enabled: boolean): void;
	send(message: Uint8Array, port: number, address: string, callback: (error: Error | null) => void): void;
	close(): void;
}

export interface KasaScannerDeps {
	interfaces?: () => KasaInterfaceList;
	socketFactory?: () => KasaUdpSocket;
	clock?: Pick<Ambient, "setTimer" | "clearTimer">;
}

function ipv4Parts(value: string): number[] | null {
	const parts = value.split(".");
	if (parts.length !== 4) return null;
	const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
	return numbers;
}

function ipv4Number(parts: number[]): number {
	return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function ipv4Text(value: number): string {
	return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function broadcastOf(address: string, netmask: string): string | null {
	const addressParts = ipv4Parts(address);
	const maskParts = ipv4Parts(netmask);
	if (!addressParts || !maskParts) return null;
	const hostMask = ~ipv4Number(maskParts) >>> 0;
	// /31, /32 lack broadcast.
	if (hostMask < 2) return null;
	return ipv4Text((ipv4Number(addressParts) | hostMask) >>> 0);
}

function broadcastAddresses(interfaces: KasaInterfaceList): string[] {
	const addresses: string[] = [];
	for (const entries of Object.values(interfaces)) {
		for (const entry of entries ?? []) {
			if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4) || entry.address.startsWith("127."))
				continue;
			const broadcast = broadcastOf(entry.address, entry.netmask);
			if (broadcast && DeviceAddressSchema.safeParse(broadcast).success) addresses.push(broadcast);
		}
	}
	return addresses;
}

function candidateFrom(message: Uint8Array, remote: Pick<RemoteInfo, "address">) {
	try {
		const decoded = JSON.parse(decrypt(message)) as {
			system?: { get_sysinfo?: Record<string, unknown> };
		};
		const info = decoded.system?.get_sysinfo;
		if (!info) return null;
		const mac = typeof info.mac === "string" ? normalizeDeviceMac(info.mac) : null;
		if (!mac) return null;
		const parsed = DeviceCandidateSchema.safeParse({
			mac,
			address: remote.address,
			alias: info.alias,
			model: info.model,
			hardware: info.hw_ver,
			firmware: info.sw_ver,
		});
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function createKasaScanner(deps: KasaScannerDeps = {}): () => Promise<HostKasaScanResult> {
	const listInterfaces = deps.interfaces ?? networkInterfaces;
	const socketFactory = deps.socketFactory ?? (() => createSocket("udp4") as unknown as KasaUdpSocket);
	const clock = deps.clock ?? processAmbient();

	return async () => {
		let broadcasts: string[];
		try {
			broadcasts = broadcastAddresses(listInterfaces());
		} catch {
			return HostKasaScanResultSchema.parse({ reason: "no_interface" });
		}
		if (broadcasts.length === 0) return HostKasaScanResultSchema.parse({ reason: "no_interface" });

		let socket: KasaUdpSocket;
		try {
			socket = socketFactory();
		} catch {
			return HostKasaScanResultSchema.parse({ reason: "socket" });
		}

		return new Promise((resolve) => {
			const candidates: Array<ReturnType<typeof DeviceCandidateSchema.parse>> = [];
			const seen = new Set<string>();
			let timer: TimerHandle | undefined;
			let settled = false;
			let datagrams = 0;
			const finish = (result: HostKasaScanResult): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clock.clearTimer(timer);
				try {
					socket.close();
				} catch {}
				resolve(HostKasaScanResultSchema.parse(result));
			};

			try {
				timer = clock.setTimer(() => {
					finish({ reason: "socket" });
				}, SCAN_WINDOW_MS);
				socket.on("error", () => finish({ reason: "socket" }));
				socket.on("message", (message, remote) => {
					if (settled) return;
					datagrams += 1;
					if (message.byteLength <= MAX_SCAN_DATAGRAM_BYTES && candidates.length < DEVICE_MAX_RECORDS) {
						const candidate = candidateFrom(message, remote);
						if (candidate && !seen.has(candidate.mac)) {
							seen.add(candidate.mac);
							candidates.push(candidate);
						}
					}
					if (datagrams >= MAX_SCAN_DATAGRAMS) finish({ candidates });
				});
				socket.once("listening", () => {
					try {
						if (timer !== undefined) clock.clearTimer(timer);
						timer = clock.setTimer(() => finish({ candidates }), SCAN_WINDOW_MS);
						socket.setBroadcast(true);
						let failedSends = 0;
						for (const address of broadcasts) {
							socket.send(DISCOVERY_REQUEST, DISCOVERY_PORT, address, (error) => {
								if (error && ++failedSends === broadcasts.length) finish({ reason: "socket" });
							});
						}
					} catch {
						finish({ reason: "socket" });
					}
				});
				socket.bind(0);
			} catch {
				finish({ reason: "socket" });
			}
		});
	};
}
