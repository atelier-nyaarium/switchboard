import type { Ambient } from "../../shared/ambient.js";
import { deviceNameRefusal } from "../../shared/schemasDevices.js";
import type { DeviceConsoleHandlers } from "../console/consoleTypes.js";
import type { DeviceVerb } from "../devices/driver.js";
import type { KasaTransport } from "../devices/kasa/transport.js";
import { createDeviceRoad, Decline, type Plug } from "../devices/road.js";
import { createDeviceScan, type KasaScanRelay } from "../devices/scan.js";
import {
	addShape,
	assistantListShape,
	assistantSetShape,
	type DeviceListActionResult,
	type DeviceSetActionResult,
	listShape,
	readShape,
	removeShape,
	renameShape,
	resolveTarget,
	scanShape,
	schedulePutShape,
	setShape,
	settingPutShape,
} from "../devices/shapes.js";
import type { DeviceStore } from "../devices/store.js";

export type { DeviceListActionResult, DeviceSetActionResult } from "../devices/shapes.js";

/** Per-plug bounds. */
export const DEVICE_IDENTIFY_WAIT_MS = 3_000;
export const DEVICE_READ_WAIT_MS = 5_000;

export interface DeviceStageDeps {
	dataDir: string;
	ambient: Ambient;
	relayToHost: KasaScanRelay;
	transport?: KasaTransport;
	deviceStore?: DeviceStore;
	onChanged?: (deviceId: string) => void;
}

export interface DeviceStage {
	console: DeviceConsoleHandlers;
	listDevices: () => Promise<DeviceListActionResult>;
	setDevice: (target: string, verb: DeviceVerb) => Promise<DeviceSetActionResult>;
	close: () => Promise<void>;
}

export function composeDevices(deps: DeviceStageDeps): DeviceStage {
	const road = createDeviceRoad(deps);
	const runScan = createDeviceScan(deps.relayToHost);

	const relay = (plug: Plug, verb: DeviceVerb) =>
		plug.drive(
			(ctx) => plug.driver.set(plug.record, verb, ctx),
			verb === "toggle" ? "toggles-relay" : "confirms-relay",
		);

	const handlers: DeviceConsoleHandlers = {
		list: () => road.operation("console", listShape, async () => road.reads.list()),
		read: (id) =>
			road.onDevice("console", readShape, id, async (plug) => {
				const read = await plug.drive((ctx) => plug.driver.read(plug.record, ctx), "confirms-relay");
				return { state: read.state, schedule: read.schedule };
			}),
		scan: () =>
			road.operation("console", scanShape, async (op) => {
				const found = await op.race(runScan());
				for (const candidate of found.candidates ?? []) {
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
				return found;
			}),
		add: (request) =>
			road.onSlot("console", addShape, request.mac, async (slot) => {
				const refusal = deviceNameRefusal(request.name);
				if (refusal) return { stored: false, reason: refusal };
				const current = slot.record;
				if (current && current.address === request.address && current.name === request.name) {
					return { stored: true, record: current };
				}
				await slot.identify(request.address, request.mac);
				return slot.write.add(request);
			}),
		rename: (id, name, revision) =>
			road.onDevice("console", renameShape, id, async (plug) => {
				const refusal = deviceNameRefusal(name);
				if (refusal) return { stored: false, record: plug.record, reason: refusal };
				if (plug.record.name === name) return plug.write.rename(name, revision);
				plug.expect(revision);
				const { previous } = await plug.drive((ctx) => plug.driver.rename(plug.record, name, ctx));
				const committed = plug.write.rename(name, revision);
				if (committed.stored) return committed;
				const restored = await plug.attempt((ctx) =>
					plug.driver.rename(plug.record, previous ?? plug.record.name, ctx),
				);
				return restored.ok ? committed : { ...committed, detail: `the plug may still be named ${name}` };
			}),
		remove: (id, revision) => road.onSlot("console", removeShape, id, async (slot) => slot.write.remove(revision)),
		set: (id, verb) => road.onDevice("console", setShape, id, async (plug) => ({ state: await relay(plug, verb) })),
		schedulePut: (id, revision, schedule) =>
			road.onDevice("console", schedulePutShape, id, async (plug) => {
				plug.expect(revision);
				return { schedule: await plug.drive((ctx) => plug.driver.schedule(plug.record, ctx).put(schedule)) };
			}),
		settingPut: (id, revision, setting) =>
			road.onDevice("console", settingPutShape, id, async (plug) => {
				plug.expect(revision);
				return { settings: await plug.drive((ctx) => plug.driver.settings(plug.record, ctx).put(setting)) };
			}),
	};

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
					const row = { id: record.id, name: record.name, kind: record.kind };
					if (outcome.ok) {
						const { record: held, read } = outcome.value;
						return { id: held.id, name: held.name, kind: held.kind, state: read.state.state };
					}
					if (outcome.why.kind === "missing" || outcome.why.kind === "refused") return null;
					const unreachable = outcome.why.kind === "failed" && outcome.why.failure.kind === "unreachable";
					return { ...row, state: unreachable ? ("unreachable" as const) : ("unknown" as const) };
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
				if (!outcome.ok) throw new Decline(outcome.why);
				return { kind: "ok" as const, answer: outcome.value };
			},
		);

	return { console: handlers, listDevices, setDevice, close: road.close };
}
