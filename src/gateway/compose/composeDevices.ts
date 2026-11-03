import type { Ambient } from "../../shared/ambient.js";
import {
	type DeviceConsoleOp,
	type DeviceConsoleOpKind,
	type DeviceConsoleResult,
	deviceNameRefusal,
	sameSchedule,
} from "../../shared/schemasDevices.js";
import type { DeviceConsole } from "../console/consoleTypes.js";
import type { DeviceVerb } from "../devices/driver.js";
import { createHomeNetwork, type WifiNetworkRelay } from "../devices/homeNetwork.js";
import type { KasaTransport } from "../devices/kasa/transport.js";
import { createDeviceRoad, Decline, type Plug, unwrap } from "../devices/road.js";
import { createDeviceScan, type KasaScanRelay } from "../devices/scan.js";
import {
	assistantListShape,
	assistantSetShape,
	consoleShape,
	type DeviceListActionResult,
	type DeviceSetActionResult,
	resolveTarget,
} from "../devices/shapes.js";
import type { DeviceStore } from "../devices/store.js";

export type { DeviceListActionResult, DeviceSetActionResult } from "../devices/shapes.js";

/** Per-plug bounds. */
export const DEVICE_IDENTIFY_WAIT_MS = 3_000;
export const DEVICE_READ_WAIT_MS = 5_000;

export interface DeviceStageDeps {
	dataDir: string;
	ambient: Ambient;
	relayToHost: KasaScanRelay & WifiNetworkRelay;
	transport?: KasaTransport;
	deviceStore?: DeviceStore;
	onChanged?: (deviceId: string) => void;
}

export interface DeviceStage {
	console: DeviceConsole;
	listDevices: () => Promise<DeviceListActionResult>;
	setDevice: (target: string, verb: DeviceVerb) => Promise<DeviceSetActionResult>;
	close: () => Promise<void>;
}

type DeviceHandlers = {
	[K in DeviceConsoleOpKind]: (op: Extract<DeviceConsoleOp, { kind: K }>) => Promise<DeviceConsoleResult<K>>;
};

/** Handler bodies; the road does the rest. */
export function composeDevices(deps: DeviceStageDeps): DeviceStage {
	const road = createDeviceRoad(deps);
	const runScan = createDeviceScan(deps.relayToHost);
	const readHomeNetwork = createHomeNetwork(deps.relayToHost);

	const relay = (plug: Plug, verb: DeviceVerb) =>
		plug.drive(
			(ctx) => plug.driver.set(plug.record, verb, ctx),
			verb === "toggle" ? "toggles-relay" : "confirms-relay",
		);

	const handlers: DeviceHandlers = {
		device_list: () =>
			road.operation("console", consoleShape("device_list"), async () => ({ kind: "ok", ...road.reads.list() })),
		device_read: (op) =>
			road.onDevice("console", consoleShape("device_read"), op.id, async (plug) => {
				const read = await plug.drive((ctx) => plug.driver.read(plug.record, ctx), "confirms-relay");
				// Settings fail alone.
				const settings = await plug.attempt((ctx) => plug.driver.settings(plug.record, ctx).read());
				return {
					kind: "ok",
					state: read.state,
					schedule: read.schedule,
					...(settings.ok ? { settings: settings.value } : {}),
				};
			}),
		device_scan: () =>
			road.operation("console", consoleShape("device_scan"), async (op) => {
				const found = await op.race(runScan());
				if (found.kind === "refused") throw new Decline({ kind: "refused", code: found.code });
				for (const candidate of found.candidates) {
					await op.device(
						candidate.mac,
						async (slot) => {
							if (!slot.record || slot.record.address === candidate.address) return;
							await slot.identify(candidate.address, slot.record.id);
							slot.write.refreshAddress(candidate.address);
						},
						{ bound: DEVICE_IDENTIFY_WAIT_MS },
					);
				}
				return { kind: "ok", candidates: found.candidates };
			}),
		device_home_network: () =>
			road.operation("console", consoleShape("device_home_network"), async (op) => {
				const found = await op.race(readHomeNetwork());
				if (found.kind === "refused") throw new Decline({ kind: "refused", code: found.code });
				return { kind: "ok", ssid: found.ssid };
			}),
		device_add: (op) =>
			road.onSlot("console", consoleShape("device_add"), op.mac, async (slot) => {
				const refusal = deviceNameRefusal(op.name);
				if (refusal) throw new Decline({ kind: "refused", code: "invalid", text: refusal });
				const current = slot.record;
				if (current && current.address === op.address && current.name === op.name) {
					return { kind: "ok", record: current };
				}
				await slot.identify(op.address, op.mac);
				return {
					kind: "ok",
					record: unwrap(slot.write.add({ mac: op.mac, address: op.address, name: op.name })),
				};
			}),
		device_rename: (op) =>
			road.onDevice("console", consoleShape("device_rename"), op.id, async (plug) => {
				const refusal = deviceNameRefusal(op.name);
				if (refusal)
					throw new Decline({ kind: "refused", code: "invalid", text: refusal, record: plug.record });
				if (plug.record.name === op.name)
					return { kind: "ok", record: unwrap(plug.write.rename(op.name, op.revision)) };
				plug.expect(op.revision);
				const { previous } = await plug.drive((ctx) => plug.driver.rename(plug.record, op.name, ctx));
				const committed = plug.write.rename(op.name, op.revision);
				if (committed.ok) return { kind: "ok", record: committed.value };
				const restored = await plug.attempt((ctx) =>
					plug.driver.rename(plug.record, previous ?? plug.record.name, ctx),
				);
				throw new Decline(restored.ok ? committed.why : { ...committed.why, effect: "unknown" });
			}),
		device_remove: (op) =>
			road.onSlot("console", consoleShape("device_remove"), op.id, async (slot) => {
				unwrap(slot.write.remove(op.revision));
				return { kind: "ok" };
			}),
		device_set: (op) =>
			road.onDevice("console", consoleShape("device_set"), op.id, async (plug) => ({
				kind: "ok",
				state: await relay(plug, op.verb),
			})),
		device_schedule_put: (op) =>
			road.onDevice("console", consoleShape("device_schedule_put"), op.id, async (plug) => {
				plug.expect(op.revision);
				const held = await plug.drive((ctx) => plug.driver.schedule(plug.record, ctx).read());
				if (!sameSchedule(held, op.base)) {
					throw new Decline({
						kind: "refused",
						code: "stale",
						text: "the plug's schedule changed since it was read",
					});
				}
				const schedule = await plug.drive((ctx) => plug.driver.schedule(plug.record, ctx).put(op.schedule));
				return { kind: "ok", schedule };
			}),
		device_setting_put: (op) =>
			road.onDevice("console", consoleShape("device_setting_put"), op.id, async (plug) => {
				plug.expect(op.revision);
				const settings = await plug.drive((ctx) => plug.driver.settings(plug.record, ctx).put(op.setting));
				return { kind: "ok", settings };
			}),
	};

	// Correlated union cast.
	const deviceConsole: DeviceConsole = (op) => (handlers[op.kind] as (op: DeviceConsoleOp) => Promise<never>)(op);

	const listDevices: DeviceStage["listDevices"] = () =>
		road.operation("assistant", assistantListShape, async (op) => {
			const records = road.reads.list().records;
			const devices = await Promise.all(
				records.map(async (record) => {
					const outcome = await op.plug(
						record.id,
						async (plug) => ({
							record: plug.record,
							read: await plug.drive((ctx) => plug.driver.read(plug.record, ctx), "confirms-relay"),
						}),
						{ bound: DEVICE_READ_WAIT_MS },
					);
					if (outcome.ok) {
						const { record: held, read } = outcome.value;
						return { id: held.id, name: held.name, kind: held.kind, state: read.state.state };
					}
					if (outcome.why.kind === "refused") return null;
					const unreachable =
						outcome.why.kind === "failed" &&
						(outcome.why.failure.kind === "unreachable" || outcome.why.failure.kind === "wrong_device");
					return {
						id: record.id,
						name: record.name,
						kind: record.kind,
						state: unreachable ? ("unreachable" as const) : ("unknown" as const),
					};
				}),
			);
			return {
				kind: "ok" as const,
				answer: { devices: devices.filter((device): device is NonNullable<typeof device> => device !== null) },
			};
		});

	const setDevice: DeviceStage["setDevice"] = (target, verb) =>
		road.operation(
			"assistant",
			assistantSetShape(target, () => road.reads.list().records),
			async (op) => {
				const resolved = resolveTarget(target, road.reads.list().records);
				if ("refused" in resolved) return { kind: "refused" as const, reason: resolved.refused };
				const outcome = await op.plug(resolved.id, async (plug) => ({
					id: plug.record.id,
					state: (await relay(plug, verb)).state,
				}));
				return { kind: "ok" as const, answer: unwrap(outcome) };
			},
		);

	return { console: deviceConsole, listDevices, setDevice, close: road.close };
}
