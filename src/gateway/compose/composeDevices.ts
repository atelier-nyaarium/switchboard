import type { Ambient } from "../../shared/ambient.js";
import {
	type DeviceConsoleOp,
	type DeviceConsoleOpKind,
	type DeviceConsoleResult,
	type DeviceRecord,
	deviceNameRefusal,
	sameSchedule,
} from "../../shared/schemasDevices.js";
import {
	type DeviceToolOp,
	type DeviceToolOpKind,
	type DeviceToolResult,
	dangerActOf,
} from "../../shared/schemasDeviceTool.js";
import { deviceCapabilitiesOf } from "../../shared/schemasIntegrations.js";
import type { DeviceConsole } from "../console/consoleTypes.js";
import type { DeviceVerb } from "../devices/driver.js";
import { createHomeNetwork, type WifiNetworkRelay } from "../devices/homeNetwork.js";
import type { KasaTransport } from "../devices/kasa/transport.js";
import { createDeviceRoad, Decline, type Plug, type Shape, type Surface, unwrap } from "../devices/road.js";
import { createDeviceScan, type KasaScanRelay } from "../devices/scan.js";
import { assistantShape, consoleShape } from "../devices/shapes.js";
import type { DeviceStore } from "../devices/store.js";

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

/** A danger act needs `approved`. */
export type DeviceAssistant = <Op extends DeviceToolOp>(
	op: Op,
	approval?: "approved",
) => Promise<DeviceToolResult<Op["kind"]>>;

export interface DeviceStage {
	console: DeviceConsole;
	assistant: DeviceAssistant;
	record: (id: string) => DeviceRecord | null;
	close: () => Promise<void>;
}

type Body<K extends DeviceConsoleOpKind> = (
	surface: Surface,
	shape: Shape<DeviceConsoleResult<K>>,
	op: Extract<DeviceConsoleOp, { kind: K }>,
) => Promise<DeviceConsoleResult<K>>;

type Bodies = { [K in DeviceConsoleOpKind]: Body<K> };

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

	const bodies: Bodies = {
		device_list: (surface, shape) =>
			road.operation(surface, shape, async () => ({ kind: "ok", ...road.reads.list() })),
		device_read: (surface, shape, op) =>
			road.onDevice(surface, shape, op.id, async (plug) => {
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
		device_scan: (surface, shape) =>
			road.operation(surface, shape, async (op) => {
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
		device_home_network: (surface, shape) =>
			road.operation(surface, shape, async (op) => {
				const found = await op.race(readHomeNetwork());
				if (found.kind === "refused") throw new Decline({ kind: "refused", code: found.code });
				return { kind: "ok", ssid: found.ssid };
			}),
		device_add: (surface, shape, op) =>
			road.onSlot(surface, shape, op.mac, async (slot) => {
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
		device_rename: (surface, shape, op) =>
			road.onDevice(surface, shape, op.id, async (plug) => {
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
		device_remove: (surface, shape, op) =>
			road.onSlot(surface, shape, op.id, async (slot) => {
				unwrap(slot.write.remove(op.revision));
				return { kind: "ok" };
			}),
		device_set: (surface, shape, op) =>
			road.onDevice(surface, shape, op.id, async (plug) => ({
				kind: "ok",
				state: await relay(plug, op.verb),
			})),
		device_schedule_put: (surface, shape, op) =>
			road.onDevice(surface, shape, op.id, async (plug) => {
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
		device_setting_put: (surface, shape, op) =>
			road.onDevice(surface, shape, op.id, async (plug) => {
				plug.expect(op.revision);
				const settings = await plug.drive((ctx) => plug.driver.settings(plug.record, ctx).put(op.setting));
				return { kind: "ok", settings };
			}),
	};

	// Correlated union cast.
	const body = <K extends DeviceConsoleOpKind>(kind: K) => bodies[kind] as unknown as Body<DeviceConsoleOpKind>;

	const deviceConsole: DeviceConsole = (op) =>
		body(op.kind)("console", consoleShape(op.kind), op) as Promise<DeviceConsoleResult<never>>;

	const listForAssistant = (): Promise<DeviceToolResult<"device_list">> =>
		road.operation("assistant", assistantShape("device_list"), async (op) => {
			const devices = await Promise.all(
				road.reads.list().records.map(async (record) => {
					const outcome = await op.plug(
						record.id,
						async (plug) => ({
							record: plug.record,
							state: (await plug.drive((ctx) => plug.driver.read(plug.record, ctx), "confirms-relay"))
								.state.state,
						}),
						{ bound: DEVICE_READ_WAIT_MS },
					);
					if (!outcome.ok && outcome.why.kind === "refused") return null;
					const unreachable =
						!outcome.ok &&
						outcome.why.kind === "failed" &&
						(outcome.why.failure.kind === "unreachable" || outcome.why.failure.kind === "wrong_device");
					const { id, name, kind, driver, revision } = outcome.ok ? outcome.value.record : record;
					return {
						id,
						name,
						kind,
						driver,
						revision,
						state: outcome.ok
							? outcome.value.state
							: unreachable
								? ("unreachable" as const)
								: ("unknown" as const),
						capabilities: [...deviceCapabilitiesOf(driver)],
					};
				}),
			);
			return { kind: "ok", devices: devices.filter((device) => device !== null) };
		});

	const assistant: DeviceAssistant = <Op extends DeviceToolOp>(op: Op, approval?: "approved") => {
		type Result = Promise<DeviceToolResult<Op["kind"]>>;
		if (op.kind === "device_list") return listForAssistant() as Result;
		const shape = assistantShape(op.kind as DeviceToolOpKind);
		if (approval !== "approved" && "id" in op && dangerActOf(op, road.reads.get(op.id)?.driver)) {
			return Promise.resolve(
				shape.decline({ kind: "refused", code: "invalid", text: "this act needs the owner's approval" }),
			) as Result;
		}
		// Assistant schema narrows the body.
		const narrowed = shape as unknown as Shape<DeviceConsoleResult<Op["kind"]>>;
		return body(op.kind)("assistant", narrowed, op) as unknown as Result;
	};

	return { console: deviceConsole, assistant, record: (id) => road.reads.get(id), close: road.close };
}
