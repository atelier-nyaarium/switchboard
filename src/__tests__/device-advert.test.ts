import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeDevices } from "../gateway/compose/composeDevices.js";
import { composeHost, type HostStageDeps } from "../gateway/compose/composeHost.js";
import { composeWebSockets, ingestDeviceAdvertFromCurrentHost } from "../gateway/compose/composeWebSockets.js";
import { createDeviceStore } from "../gateway/devices/store.js";
import type { Advert } from "../shared/ble-recognition.js";
import { VALUE_OP_KINDS } from "../shared/schemasConsoleOp.js";
import { DeviceAdvertFrameSchema } from "../shared/schemasDeviceBluetooth.js";
import { DEVICE_TOOL_OFFERS } from "../shared/schemasDeviceTool.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";
import { createFakeSocket } from "../testing/fakeSocket.js";

const GATEWAY_MAC = "ce:1c:44:06:3c:5d";
const PHONE_MAC = "ce:1c:44:06:3c:5e";
const advert: Advert = { name: "GVH5110_3C5D", data: { "1": "010103bac864" }, services: ["ec88"] };
const colderAdvert: Advert = { name: "GVH5110_3C5D", data: { "1": "010180d16c5a" }, services: ["ec88"] };
const phoneAdvert = { ...advert, data: { ...advert.data }, services: [...advert.services] };
const colderPhoneAdvert = { ...colderAdvert, data: { ...colderAdvert.data }, services: [...colderAdvert.services] };

function memoryStore(onChanged: () => void = () => {}) {
	let snapshot: unknown = null;
	return createDeviceStore({
		store: {
			load: () => snapshot,
			saveChecked: (next) => {
				snapshot = structuredClone(next);
			},
		},
		onChanged,
	});
}

function seedSensor(store: ReturnType<typeof createDeviceStore>, mac: string, radio: "gateway" | "phones"): void {
	const result = store.addSensor({
		mac,
		name: "Freezer",
		driver: "govee",
		radio,
		definition: "govee-h5110",
	});
	if (!result.stored) throw new Error(result.reason);
}

function makeSessions(registry: HostStageDeps["sessions"]["registry"]): HostStageDeps["sessions"] {
	return {
		registry,
		sessionStore: { getByTeam: () => null } as never,
		presence: { snapshot: () => [] } as never,
		isAvailableProject: () => false,
		hostSpawnPoints: { known: false, ids: [] },
		knownTeamPaths: new Map(),
		offlineCatalog: new Map(),
	} as HostStageDeps["sessions"];
}

describe("Bluetooth advertisement flow", () => {
	it("pushes the replacement watch on host registration and store changes", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-watch-"));
		const ambient = fakeAmbient({ now: () => 10_000 });
		const socket = createFakeSocket();
		const registry = new Map() as HostStageDeps["sessions"]["registry"];
		let host: ReturnType<typeof composeHost> | undefined;
		const store = memoryStore(() => host?.pushDeviceWatch());
		const stage = composeDevices({
			dataDir,
			ambient,
			deviceStore: store,
			relayToHost: async () => ({ ok: false, errorKind: "daemon_away" }) as never,
			sightings: () => advert,
		});
		host = composeHost({
			sessions: makeSessions(registry),
			wakeTimeoutMs: 1_000,
			ambient,
			deviceWatch: stage.deviceWatch,
		});
		const webSockets = composeWebSockets({
			ambient,
			stores: {
				pendingDeliveries: { listForTeam: () => [] },
				daemonCapabilityStore: {},
			} as never,
			sessions: {
				registry,
				conversationRegistry: new Map(),
				knownTeamPaths: new Map(),
				offlineCatalog: new Map(),
				hostSpawnPoints: { known: false, ids: [] },
				presence: { snapshot: () => [], markDirty: () => {}, clearAllWorking: () => {} },
				sessionStore: { getByTeam: () => null },
				purgeQueue: { kick: () => {} },
			} as never,
			host,
			agents: { stacks: new Map() } as never,
			workflows: {
				hostRegistering: () => {},
				hostRegistered: () => {},
				catalogChanged: () => {},
				claudeTurnResult: async () => {},
			} as never,
			federation: { channelDeliveryAck: () => {} } as never,
			observer: { offered: () => {}, acknowledged: () => {} },
			hostWsToken: "secret",
		});

		try {
			webSockets.wsHandlers.open(socket.ws);
			webSockets.wsHandlers.message(
				socket.ws,
				JSON.stringify({ type: "register", team: "host", subId: "daemon", token: "secret" }),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(socket.sent.at(-1)).toEqual({ type: "device_watch", watch: [] });
			await stage.console({
				kind: "device_add",
				mac: GATEWAY_MAC,
				name: "Freezer",
				radio: "gateway",
				definition: "govee-h5110",
			});
			expect(socket.sent.at(-1)).toEqual({
				type: "device_watch",
				watch: [{ mac: GATEWAY_MAC, activeScan: false }],
			});
		} finally {
			await stage.close();
			ambient.clearInterval(host.presenceWatchTimer);
			ambient.clearInterval(host.deviceWatchTimer);
			ambient.clearInterval(webSockets.wsHandlers.heartbeatInterval);
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("ingests only current host observations for watched gateway sensors", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-advert-"));
		const ambient = fakeAmbient({ now: () => 10_000 });
		const store = memoryStore();
		seedSensor(store, GATEWAY_MAC, "gateway");
		seedSensor(store, PHONE_MAC, "phones");
		const landed: string[][] = [];
		const stage = composeDevices({
			dataDir,
			ambient,
			deviceStore: store,
			relayToHost: async () => ({ ok: false, errorKind: "daemon_away" }) as never,
			onIngested: (keys) => landed.push([...keys]),
		});
		const currentSocket = {};
		const oldSocket = {};
		const host = { readLiveness: () => ({ socket: currentSocket }) } as never;
		const frame = DeviceAdvertFrameSchema.parse({
			type: "device_advert",
			observations: [
				{ mac: GATEWAY_MAC, advert, at: 1_000 },
				{ mac: PHONE_MAC, advert, at: 1_000 },
				{ mac: "aa:bb:cc:dd:ee:01", advert, at: 1_000 },
			],
		});
		const ingest = (mac: string, value: typeof advert, at: number) => stage.ingestGatewayAdvert(mac, value, at);

		try {
			expect(stage.deviceWatch()).toEqual([{ mac: GATEWAY_MAC, activeScan: false }]);
			ingestDeviceAdvertFromCurrentHost(host, frame, oldSocket, ingest);
			expect(landed).toEqual([]);
			ingestDeviceAdvertFromCurrentHost(host, frame, currentSocket, ingest);
			expect(landed).toEqual([
				[
					`device:${GATEWAY_MAC}/temperature`,
					`device:${GATEWAY_MAC}/humidity`,
					`device:${GATEWAY_MAC}/battery`,
				],
			]);
			expect((await stage.console({ kind: "device_read", id: GATEWAY_MAC })).kind).toBe("sensor");
			expect(await stage.console({ kind: "device_read", id: PHONE_MAC })).toMatchObject({
				stale: "not heard yet",
			});
		} finally {
			await stage.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("accepts phone posts, refuses gateway records, ignores future or foreign captures, and keeps 24-hour extremes", async () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-reading-post-"));
		const ambient = fakeAmbient({ now: () => 10_000 });
		const store = memoryStore();
		seedSensor(store, GATEWAY_MAC, "gateway");
		seedSensor(store, PHONE_MAC, "phones");
		const landed: string[][] = [];
		const stage = composeDevices({
			dataDir,
			ambient,
			deviceStore: store,
			relayToHost: async () => ({ ok: false, errorKind: "daemon_away" }) as never,
			onIngested: (keys) => landed.push([...keys]),
		});

		try {
			expect(VALUE_OP_KINDS.has("device_reading_post")).toBe(true);
			expect(DEVICE_TOOL_OFFERS.device_reading_post).toBe(false);
			expect(
				await stage.console({ kind: "device_reading_post", id: GATEWAY_MAC, advert: phoneAdvert, at: 1_000 }),
			).toMatchObject({ kind: "refused", refusal: { code: "not_supported" } });
			expect(
				await stage.console({ kind: "device_reading_post", id: PHONE_MAC, advert: phoneAdvert, at: 1_000 }),
			).toEqual({ kind: "ok" });
			expect(
				await stage.console({
					kind: "device_reading_post",
					id: PHONE_MAC,
					advert: colderPhoneAdvert,
					at: 2_000,
				}),
			).toEqual({ kind: "ok" });
			const acceptedKeys = landed.length;
			expect(
				await stage.console({ kind: "device_reading_post", id: PHONE_MAC, advert: phoneAdvert, at: 1_500 }),
			).toEqual({ kind: "ok" });
			expect(landed).toHaveLength(acceptedKeys + 1);
			expect(landed.at(-1)).toEqual([]);
			const ahead = {
				kind: "device_reading_post",
				id: PHONE_MAC,
				advert: phoneAdvert,
				at: 10_000 + 3_600_000,
			} as const;
			await stage.console(ahead);
			expect(landed.at(-1)).toEqual([]);
			const stranger = { ...phoneAdvert, data: { "1": "ffff00000000" } };
			await stage.console({ kind: "device_reading_post", id: PHONE_MAC, advert: stranger, at: 3_000 });
			expect(landed.at(-1)).toEqual([]);

			const answer = await stage.console({ kind: "device_read", id: PHONE_MAC });
			expect(answer).toMatchObject({ kind: "sensor", heardAt: 2_000 });
			if (answer.kind !== "sensor") throw new Error("sensor read expected");
			const temperature = answer.readings.find((reading) => reading.spec.field === "temperature");
			expect(temperature).toMatchObject({
				value: -5.3,
				low: { value: -5.3, at: 2_000 },
				high: { value: 24.4, at: 1_000 },
			});
		} finally {
			await stage.close();
			fs.rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
