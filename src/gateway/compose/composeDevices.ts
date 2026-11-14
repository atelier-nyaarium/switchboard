import type { Ambient } from "../../shared/ambient.js";
import { type Advert, familyOf } from "../../shared/ble-recognition.js";
import { definitionOf, identifies, SHIPPED_DEFINITIONS } from "../../shared/device-definitions/index.js";
import { type FieldRef, refKey } from "../../shared/expressions.js";
import type { TemperatureUnit } from "../../shared/schemasAssistant.js";
import { type DeviceWatchEntry, DeviceWatchFrameSchema } from "../../shared/schemasDeviceBluetooth.js";
import {
	type DeviceConsoleOp,
	type DeviceConsoleOpKind,
	type DeviceConsoleResult,
	type DeviceRadio,
	type DeviceRecord,
	type DeviceSensorThreshold,
	type DeviceSensorThresholdPutRequest,
	DRIVER_KINDS,
	type DriverOf,
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
import type { FieldInput } from "../computed/computedFields.js";
import type { DeviceConsole } from "../console/consoleTypes.js";
import type { DeviceVerb, SensorReads } from "../devices/driver.js";
import { createHomeNetwork, type WifiNetworkRelay } from "../devices/homeNetwork.js";
import type { KasaTransport } from "../devices/kasa/transport.js";
import { createDeviceRoad, Decline, type Plug, type Shape, type Slot, type Surface, unwrap } from "../devices/road.js";
import { createDeviceScan, type KasaScanRelay } from "../devices/scan.js";
import { createSensorReadings } from "../devices/sensorReadings.js";
import type { SensorThresholdPutAnswer } from "../devices/sensorThresholds.js";
import { assistantShape, consoleShape } from "../devices/shapes.js";
import type { DeviceStore } from "../devices/store.js";

const isSensorDriver = (family: string): family is DriverOf<"sensor"> =>
	(DRIVER_KINDS as Record<string, string>)[family] === "sensor";

/** Per-plug bounds. */
export const DEVICE_IDENTIFY_WAIT_MS = 3_000;
export const DEVICE_READ_WAIT_MS = 5_000;
const DEVICE_SENSOR_STALE_AFTER_MS = 15 * 60_000;

export interface DeviceStageDeps {
	dataDir: string;
	ambient: Ambient;
	relayToHost: KasaScanRelay & WifiNetworkRelay;
	transport?: KasaTransport;
	deviceStore?: DeviceStore;
	onChanged?: (deviceId: string) => void;
	onIngested?: (keys: readonly string[]) => void;
	temperatureUnit?: () => TemperatureUnit;
	sensors?: SensorReads;
	sightings?: (mac: string) => Advert | null;
	thresholds?: {
		read: (record: DeviceRecord) => DeviceSensorThreshold[];
		put: (record: DeviceRecord, op: DeviceSensorThresholdPutRequest) => SensorThresholdPutAnswer;
		/** False retries on tick. */
		forget: (device: string) => boolean;
	};
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
	records: () => readonly DeviceRecord[];
	/** Unread rows included. */
	holds: (id: string) => boolean;
	deviceWatch: () => DeviceWatchEntry[];
	sensorInput: (ref: FieldRef) => FieldInput | null;
	sensorInputKeys: () => string[];
	ingestGatewayAdvert: (mac: string, advert: Advert, at: number) => string[];
	flushReadings: () => boolean;
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
	const nearbySightings = new Map<string, Advert>();
	const sensorReadings = createSensorReadings({
		record: (mac) => road.reads.get(mac),
		latest: (mac) => road.readings.latest(mac),
		now: () => deps.ambient.now(),
		staleAfterMs: DEVICE_SENSOR_STALE_AFTER_MS,
		extremes: road.readings.extremes,
	});
	const sensors = deps.sensors ?? sensorReadings;
	const sensorInput = sensorReadings.input;
	const sightings = (mac: string): Advert | null => nearbySightings.get(mac) ?? deps.sightings?.(mac) ?? null;
	const ingest = (mac: string, advert: Advert, at: number, radio: DeviceRadio): string[] | null => {
		const keys = road.ingest(mac, advert, at, radio);
		if (keys === null) return null;
		deps.onIngested?.(keys);
		return keys;
	};
	const deviceWatch = (): DeviceWatchEntry[] =>
		DeviceWatchFrameSchema.parse({
			type: "device_watch",
			watch: road.reads
				.list()
				.records.filter((record) => record.kind === "sensor" && record.radio === "gateway")
				.map((record) => ({
					mac: record.id,
					activeScan: record.definition
						? (definitionOf(record.definition)?.match.activeScan ?? false)
						: false,
				})),
		}).watch;
	const sensorInputKeys = (): string[] =>
		road.reads.list().records.flatMap((record) => {
			if (record.kind !== "sensor" || !record.definition) return [];
			const definition = definitionOf(record.definition);
			return (
				definition?.readings.map((reading) =>
					refKey({ source: "device", device: record.id, key: reading.key }),
				) ?? []
			);
		});
	const ingestGatewayAdvert = (mac: string, advert: Advert, at: number): string[] => {
		const record = road.reads.get(mac);
		return record?.kind === "sensor" && record.radio === "gateway"
			? (ingest(mac, advert, at, "gateway") ?? [])
			: [];
	};

	const bySensor = <A>(
		surface: Surface,
		shape: Shape<A>,
		id: string,
		sensor: (slot: Slot & { record: DeviceRecord }) => Promise<A>,
		plug: (plug: Plug) => Promise<A>,
	): Promise<A> =>
		road.reads.get(id)?.kind === "sensor"
			? road.onSlot(surface, shape, id, async (slot) => {
					if (slot.record?.kind !== "sensor") throw new Decline({ kind: "refused", code: "not_found" });
					return sensor({ ...slot, record: slot.record });
				})
			: road.onDevice(surface, shape, id, plug);

	/** No identify for sensors. */
	const addSensor = (
		slot: Slot,
		op: Extract<DeviceConsoleOp, { kind: "device_add" }>,
		radio: NonNullable<DeviceRecord["radio"]>,
	): DeviceRecord => {
		if (radio === "gateway" && runScan.bluetooth() === false) {
			throw new Decline({ kind: "refused", code: "no_radio", text: "this Gateway's host has no Bluetooth" });
		}
		// Phones pair from adverts.
		const heard = (radio === "phones" ? op.advert : undefined) ?? sightings(op.mac);
		if (!heard) throw new Decline({ kind: "refused", code: "not_found", text: "not heard nearby; scan again" });
		const family = familyOf(heard);
		if (family === null || !isSensorDriver(family)) {
			throw new Decline({
				kind: "refused",
				code: "not_supported",
				text: "no catalogued sensor family sends this",
			});
		}
		if (op.definition !== undefined) {
			const definition = definitionOf(op.definition);
			if (!definition || definition.family !== family || !identifies(definition, heard)) {
				throw new Decline({
					kind: "refused",
					code: "invalid",
					text: "that definition does not read this device",
				});
			}
		}
		// Pairing clears orphaned alerts.
		if (!road.reads.holds(op.mac) && deps.thresholds && !deps.thresholds.forget(op.mac)) {
			throw new Decline({ kind: "refused", code: "write_failed", text: "old alert settings were not cleared" });
		}
		// Bind a unique match.
		const fits = SHIPPED_DEFINITIONS.filter((entry) => entry.family === family && identifies(entry, heard));
		const definition = op.definition ?? (fits.length === 1 ? fits[0]?.key : undefined);
		return unwrap(
			slot.write.addSensor({
				mac: op.mac,
				name: op.name,
				driver: family,
				radio,
				...(definition === undefined ? {} : { definition }),
			}),
		);
	};

	const relay = (plug: Plug, verb: DeviceVerb) =>
		plug.drive(
			(ctx) => plug.driver.set(plug.record, verb, ctx),
			verb === "toggle" ? "toggles-relay" : "confirms-relay",
		);

	const bodies: Bodies = {
		device_list: (surface, shape) =>
			road.operation(surface, shape, async () => {
				const bluetooth = runScan.bluetooth();
				return { kind: "ok", ...road.reads.list(), ...(bluetooth === undefined ? {} : { bluetooth }) };
			}),
		device_read: (surface, shape, op) =>
			bySensor(
				surface,
				shape,
				op.id,
				async (slot) => {
					const model = slot.record.definition ? definitionOf(slot.record.definition)?.models[0] : undefined;
					return {
						kind: "sensor",
						...(model ? { model } : {}),
						...sensors.read(slot.record),
						payloads: road.readings.payloads(slot.record.id).map(({ advert, at, radio }) => ({
							...advert,
							data: { ...advert.data },
							services: [...advert.services],
							at,
							radio,
						})),
						...(surface === "assistant" ? { temperatureUnit: deps.temperatureUnit?.() ?? "C" } : {}),
						...(deps.thresholds ? { thresholds: deps.thresholds.read(slot.record) } : {}),
					};
				},
				async (plug) => {
					const read = await plug.drive((ctx) => plug.driver.read(plug.record, ctx), "confirms-relay");
					// Settings fail alone.
					const settings = await plug.attempt((ctx) => plug.driver.settings(plug.record, ctx).read());
					return {
						kind: "ok",
						state: read.state,
						schedule: read.schedule,
						...(settings.ok ? { settings: settings.value } : {}),
					};
				},
			),
		device_reading_post: async (_surface, shape, op) => {
			const record = road.reads.get(op.id);
			if (!record) return shape.decline({ kind: "refused", code: "not_found" });
			if (record.kind !== "sensor" || record.radio !== "phones")
				return shape.decline({ kind: "refused", code: "not_supported" });
			if (ingest(op.id, op.advert, op.at, "phones") === null) return shape.decline({ kind: "notStarted" });
			return { kind: "ok" };
		},
		sensor_threshold_put: (surface, shape, op) =>
			road.onSlot(surface, shape, op.id, async (slot) => {
				if (slot.record?.kind !== "sensor")
					throw new Decline({ kind: "refused", code: slot.record ? "not_supported" : "not_found" });
				const answer = deps.thresholds?.put(slot.record, op) ?? {
					kind: "refused" as const,
					code: "write_failed" as const,
				};
				if (answer.kind === "refused")
					throw new Decline({ kind: "refused", code: answer.code, text: answer.text });
				return answer;
			}),
		device_scan: (surface, shape) =>
			road.operation(surface, shape, async (op) => {
				const found = await op.race(runScan());
				if (found.kind === "refused") throw new Decline({ kind: "refused", code: found.code });
				nearbySightings.clear();
				for (const device of found.nearby ?? []) {
					nearbySightings.set(device.mac, {
						...(device.name ? { name: device.name } : {}),
						data: device.data,
						services: device.services ?? [],
					});
				}
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
				return {
					kind: "ok",
					candidates: found.candidates,
					...(found.nearby ? { nearby: found.nearby } : {}),
					...(found.bluetooth === undefined ? {} : { bluetooth: found.bluetooth }),
				};
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
				if (op.radio !== undefined) return { kind: "ok", record: addSensor(slot, op, op.radio) };
				if (op.address === undefined)
					throw new Decline({ kind: "refused", code: "invalid", text: "a switch needs its address" });
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
			bySensor(
				surface,
				shape,
				op.id,
				// Sensor rename is local.
				async (slot) => ({ kind: "ok", record: unwrap(slot.write.rename(op.name, op.revision)) }),
				async (plug) => {
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
				},
			),
		device_remove: (surface, shape, op) =>
			road.onSlot(surface, shape, op.id, async (slot) => {
				const held = slot.record;
				unwrap(slot.write.remove(op.revision));
				if (held?.kind === "sensor") deps.thresholds?.forget(held.id);
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
					if (record.kind === "sensor") {
						const { id, name, kind, driver, revision } = record;
						return { id, name, kind, driver, revision, state: "unknown" as const, capabilities: [] };
					}
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

	return {
		console: deviceConsole,
		assistant,
		record: (id) => road.reads.get(id),
		records: () => road.reads.list().records,
		holds: (id) => road.reads.holds(id),
		deviceWatch,
		sensorInput,
		sensorInputKeys,
		ingestGatewayAdvert,
		flushReadings: road.flushReadings,
		close: road.close,
	};
}
