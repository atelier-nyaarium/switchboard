import type { z } from "zod";
import { type Ambient, type Linked, linkedSignal } from "../../shared/ambient.js";
import type { Advert } from "../../shared/ble-recognition.js";
import { CONSOLE_ANSWER_WAIT_MS, CONSOLE_HOP_MARGIN_MS } from "../../shared/console-protocol.js";
import { definitionOf, inputsOf, matches, readingsOf } from "../../shared/device-definitions/index.js";
import { openDurable } from "../../shared/durable-store.js";
import { refKey } from "../../shared/expressions.js";
import {
	type DeviceAddFieldsSchema,
	type DeviceRecord,
	type DeviceRefusalCode,
	type DriverOf,
	deviceRefusal,
} from "../../shared/schemasDevices.js";
import { ASSISTANT_WAITS } from "../assistant/waits.js";
import {
	type DeviceDriver,
	type DeviceDriverError,
	DeviceDriverFailure,
	type DeviceOperationContext,
	effectLatch,
} from "./driver.js";
import { createKasaDriver } from "./kasa/kasaDriver.js";
import { createKasaTransport, type KasaTransport } from "./kasa/transport.js";
import { createReadingsHold } from "./readingsHold.js";
import { type DeviceStore, type DeviceStoreRefusal, openDeviceStore, type SensorAdd } from "./store.js";

/** Tolerated capture clock lead. */
export const INGEST_SKEW_MS = 2 * 60_000;

export const TOGGLE_DOUBT = "read the device first; the last toggle's outcome is unknown";

export type Surface = "console" | "assistant";
export type Effect = "none" | "unknown";
export type DeviceEffect = "confirms-relay" | "toggles-relay";

export type Refused = {
	kind: "refused";
	code: DeviceRefusalCode;
	text?: string;
	record?: DeviceRecord;
	effect?: Effect;
};

export type Declined =
	| { kind: "notStarted" }
	| Refused
	| { kind: "failed"; failure: DeviceDriverError; effect: Effect; record?: DeviceRecord };

export type Outcome<T> = { ok: true; value: T } | { ok: false; why: Declined };
export type Written<T> = { ok: true; value: T } | { ok: false; why: Refused };

export class Decline extends Error {
	constructor(readonly why: Declined) {
		super(why.kind);
		this.name = "Decline";
	}
}

export interface Shape<A> {
	schema?: z.ZodType<A>;
	decline(why: Declined): A;
}

/** One id's store writes. */
export interface DeviceWrites {
	add(request: z.input<typeof DeviceAddFieldsSchema>): Written<DeviceRecord>;
	addSensor(request: SensorAdd): Written<DeviceRecord>;
	rename(name: string, baseRevision: number): Written<DeviceRecord>;
	remove(baseRevision: number): Written<void>;
	refreshAddress(address: string): Written<DeviceRecord>;
}

export interface Slot {
	readonly id: string;
	readonly record: DeviceRecord | null;
	readonly write: DeviceWrites;
	drive<T>(work: (ctx: DeviceOperationContext) => Promise<T>, effect?: DeviceEffect): Promise<T>;
	/** Compensation, optional reads. */
	attempt<T>(work: (ctx: DeviceOperationContext) => Promise<T>): Promise<Outcome<T>>;
	identify(address: string, expected: string): Promise<void>;
	expect(revision: number): void;
}

export interface Plug extends Slot {
	readonly record: DeviceRecord;
	readonly driver: DeviceDriver;
}

export interface Operation {
	device<T>(id: string, run: (slot: Slot) => Promise<T>, options?: { bound?: number }): Promise<Outcome<T>>;
	plug<T>(id: string, run: (plug: Plug) => Promise<T>, options?: { bound?: number }): Promise<Outcome<T>>;
	/** Ends with the operation. */
	race<T>(pending: Promise<T>): Promise<T>;
}

export interface DeviceRoadDeps {
	dataDir: string;
	ambient: Ambient;
	transport?: KasaTransport;
	deviceStore?: DeviceStore;
	onChanged?: (deviceId: string) => void;
}

export interface DeviceRoad {
	operation<A>(surface: Surface, shape: Shape<A>, run: (op: Operation) => Promise<A>): Promise<A>;
	onSlot<A>(surface: Surface, shape: Shape<A>, id: string, run: (slot: Slot) => Promise<A>): Promise<A>;
	onDevice<A>(surface: Surface, shape: Shape<A>, id: string, run: (plug: Plug) => Promise<A>): Promise<A>;
	ingest(id: string, advert: Advert, at: number): string[] | null;
	reads: {
		list(): ReturnType<DeviceStore["list"]>;
		get(id: string): DeviceRecord | null;
		holds(id: string): boolean;
	};
	readings: Pick<ReturnType<typeof createReadingsHold>, "latest" | "payloads" | "extremes">;
	flushReadings(): boolean;
	close(): Promise<void>;
}

interface Lease extends Linked {
	deadlineAt: number;
}

const SURFACE_BOUND_MS: Readonly<Record<Surface, number>> = {
	console: CONSOLE_ANSWER_WAIT_MS - CONSOLE_HOP_MARGIN_MS,
	assistant: ASSISTANT_WAITS.action,
};

const NOT_STARTED: Declined = { kind: "notStarted" };

function withRecord<T extends object>(value: T, record: DeviceRecord | null): T & { record?: DeviceRecord } {
	return record ? { ...value, record } : value;
}

function refusedBy(refusal: DeviceStoreRefusal): Refused {
	return withRecord({ kind: "refused" as const, code: refusal.code, text: refusal.reason }, refusal.record ?? null);
}

export function unwrap<T>(outcome: Outcome<T>): T {
	if (!outcome.ok) throw new Decline(outcome.why);
	return outcome.value;
}

/** The one road to a store or a driver. */
export function createDeviceRoad(deps: DeviceRoadDeps): DeviceRoad {
	const store =
		deps.deviceStore ?? openDeviceStore(deps.dataDir, { onChanged: (deviceId) => deps.onChanged?.(deviceId) });
	const readings = openDurable(deps.dataDir, "sensor-readings", (durable) =>
		createReadingsHold({ store: durable, now: () => deps.ambient.now() }),
	);
	readings.keepOnly(new Set(store.list().records.map((record) => record.id)));
	const drivers: Readonly<Record<DriverOf<"switch">, DeviceDriver>> = {
		kasa: createKasaDriver({ transport: deps.transport ?? createKasaTransport() }),
	};
	const stage = new AbortController();
	const leases = new Set<Promise<void>>();
	const doubt = new Set<string>();
	let closing: Promise<void> | null = null;

	const numericReadings = (record: DeviceRecord | null, advert: Advert | null): Map<string, number | null> => {
		if (record?.kind !== "sensor" || !record.definition) return new Map();
		const definition = definitionOf(record.definition);
		if (!definition) return new Map();
		const values = advert ? readingsOf(definition, inputsOf(definition, advert)) : {};
		return new Map(
			definition.readings.flatMap((reading) => {
				const value = values[reading.key];
				if (reading.spec.kind !== "number") return [];
				const numeric =
					value?.known && typeof value.value === "number" && Number.isFinite(value.value)
						? value.value
						: null;
				return [[reading.key, numeric] as const];
			}),
		);
	};

	const ingest = (id: string, advert: Advert, at: number): string[] | null => {
		if (stage.signal.aborted) return null;
		const record = store.get(id);
		if (record?.kind !== "sensor") return [];
		// Future timestamps freeze readings.
		if (at > deps.ambient.now() + INGEST_SKEW_MS) return [];
		const definition = record.definition ? definitionOf(record.definition) : null;
		if (definition && !matches(definition, advert)) return [];
		if (!readings.ingest(id, advert, at)) return [];
		// Fresh capture clears staleness.
		const keys: string[] = [];
		for (const [key, value] of numericReadings(record, advert)) {
			if (value !== null) readings.record(id, key, value, at);
			keys.push(refKey({ source: "device", device: id, key }));
		}
		return keys;
	};

	const lease = (parent: Lease | null, ms: number): Lease => {
		const inner = linkedSignal(deps.ambient, {
			parent: parent?.signal ?? stage.signal,
			ms,
			reason: "device deadline",
		});
		const deadlineAt = Math.min(parent?.deadlineAt ?? Number.POSITIVE_INFINITY, deps.ambient.now() + ms);
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		leases.add(settled);
		return {
			...inner,
			deadlineAt,
			dispose: () => {
				inner.dispose();
				leases.delete(settled);
				settle();
			},
		};
	};

	const expired = (held: Lease): boolean => {
		if (!held.signal.aborted && deps.ambient.now() >= held.deadlineAt) held.end("device deadline");
		return held.signal.aborted;
	};

	const declineFrom = (error: unknown, marked: boolean, record: DeviceRecord | null): Declined => {
		if (error instanceof Decline) return error.why;
		const effect: Effect = marked ? "unknown" : "none";
		if (error instanceof DeviceDriverFailure) {
			const failure = error.failure;
			if (!marked && failure.kind === "timeout" && failure.sent === false) return NOT_STARTED;
			return withRecord({ kind: "failed", failure, effect }, record);
		}
		console.warn(`[device] operation failed: ${error instanceof Error ? error.message : String(error)}`);
		const failure: DeviceDriverError = { kind: "unreachable", detail: "device operation failed" };
		return withRecord({ kind: "failed", failure, effect }, record);
	};

	const makeSlot = (id: string, held: Lease): Slot => {
		const record = store.get(id);
		const driver = record?.kind === "switch" ? drivers[record.driver as DriverOf<"switch">] : drivers.kasa;
		const slot: Slot = {
			id,
			record,
			write: {
				add: (request) => {
					const result = store.add(request);
					return result.stored ? { ok: true, value: result.record } : { ok: false, why: refusedBy(result) };
				},
				addSensor: (request) => {
					const result = store.addSensor(request);
					return result.stored ? { ok: true, value: result.record } : { ok: false, why: refusedBy(result) };
				},
				rename: (name, baseRevision) => {
					const result = store.rename(id, name, baseRevision);
					return result.stored ? { ok: true, value: result.record } : { ok: false, why: refusedBy(result) };
				},
				remove: (baseRevision) => {
					const result = store.remove(id, baseRevision);
					if (!result.deleted) return { ok: false, why: refusedBy(result) };
					readings.forget(id);
					readings.flush();
					doubt.delete(id);
					return { ok: true, value: undefined };
				},
				refreshAddress: (address) => {
					const result = store.refreshAddress(id, address);
					return "code" in result
						? { ok: false, why: refusedBy(result) }
						: { ok: true, value: result.record };
				},
			},
			async drive(work, effect) {
				if (expired(held)) throw new Decline(NOT_STARTED);
				if (effect === "toggles-relay" && doubt.has(id)) {
					throw new Decline(
						withRecord({ kind: "refused", code: "toggle_unknown", text: TOGGLE_DOUBT }, record),
					);
				}
				const latch = effectLatch();
				try {
					const value = await work({ ambient: deps.ambient, signal: held.signal, effect: latch });
					if (effect) doubt.delete(id);
					return value;
				} catch (error) {
					const why = declineFrom(error, latch.marked, record);
					if (effect === "toggles-relay" && why.kind === "failed" && why.effect === "unknown") doubt.add(id);
					throw new Decline(why);
				}
			},
			async attempt(work) {
				try {
					return { ok: true, value: await slot.drive(work) };
				} catch (error) {
					return { ok: false, why: declineFrom(error, false, record) };
				}
			},
			async identify(address, expected) {
				const actual = await slot.drive((ctx) => driver.identify(address, ctx));
				if (actual !== expected) {
					throw new Decline(
						withRecord(
							{
								kind: "refused",
								code: "wrong_device",
								text: `address answers ${actual}; expected ${expected}`,
							},
							record,
						),
					);
				}
			},
			expect(revision) {
				if (record && record.revision !== revision) {
					throw new Decline({
						kind: "refused",
						code: "stale",
						record,
						text: `revision ${record.revision} is stored; this edits ${revision}`,
					});
				}
			},
		};
		return slot;
	};

	const operation = async <A>(surface: Surface, shape: Shape<A>, run: (op: Operation) => Promise<A>): Promise<A> => {
		const root = lease(null, SURFACE_BOUND_MS[surface]);
		const heldIds = new Set<string>();
		const device = async <T>(
			id: string,
			work: (slot: Slot) => Promise<T>,
			options: { bound?: number } | undefined,
			asPlug: boolean,
		): Promise<Outcome<T>> => {
			if (heldIds.has(id)) throw new Error(`device ${id} is already held by this operation`);
			const held = options?.bound === undefined ? root : lease(root, options.bound);
			try {
				if (expired(held)) return { ok: false, why: NOT_STARTED };
				let begin!: () => void;
				const started = new Promise<void>((resolve) => {
					begin = resolve;
				});
				const turn = store.perDevice(id, async (): Promise<Outcome<T>> => {
					begin();
					if (expired(held)) return { ok: false, why: NOT_STARTED };
					heldIds.add(id);
					const slot = makeSlot(id, held);
					try {
						if (asPlug) {
							if (!slot.record) return { ok: false, why: { kind: "refused", code: "not_found" } };
							const refusal = deviceRefusal(slot.record);
							if (refusal) {
								return {
									ok: false,
									why: { kind: "refused", code: "not_supported", text: refusal, record: slot.record },
								};
							}
							if (slot.record.kind !== "switch") {
								return {
									ok: false,
									why: {
										kind: "refused",
										code: "not_supported",
										text: "a sensor has no switch, schedule or settings",
										record: slot.record,
									},
								};
							}
							const driver = drivers[slot.record.driver as DriverOf<"switch">];
							const plug: Plug = { ...slot, record: slot.record, driver };
							return { ok: true, value: await (work as (plug: Plug) => Promise<T>)(plug) };
						}
						return { ok: true, value: await work(slot) };
					} catch (error) {
						return { ok: false, why: declineFrom(error, false, slot.record) };
					} finally {
						heldIds.delete(id);
					}
				});
				const first = await Promise.race([
					started.then(() => "started" as const),
					held.ended.then(() => "ended" as const),
				]);
				if (first === "ended") return { ok: false, why: NOT_STARTED };
				return await turn;
			} finally {
				if (held !== root) held.dispose();
			}
		};
		const op: Operation = {
			device: (id, work, options) => device(id, work, options, false),
			plug: (id, work, options) => device(id, work as (slot: Slot) => Promise<unknown>, options, true) as never,
			race: <T>(pending: Promise<T>): Promise<T> =>
				Promise.race([
					pending,
					root.ended.then((): never => {
						throw new Decline(NOT_STARTED);
					}),
				]),
		};
		try {
			if (expired(root)) return shape.decline(NOT_STARTED);
			const value = await run(op);
			return shape.schema ? shape.schema.parse(value) : value;
		} catch (error) {
			return shape.decline(declineFrom(error, false, null));
		} finally {
			root.end("device operation ended");
			root.dispose();
		}
	};

	const close = (): Promise<void> => {
		if (closing) return closing;
		stage.abort("device stage closed");
		closing = (async () => {
			while (leases.size > 0) await Promise.all([...leases]);
			readings.flush();
		})();
		return closing;
	};

	return {
		operation,
		onSlot: (surface, shape, id, run) => operation(surface, shape, async (op) => unwrap(await op.device(id, run))),
		onDevice: (surface, shape, id, run) => operation(surface, shape, async (op) => unwrap(await op.plug(id, run))),
		ingest,
		reads: { list: () => store.list(), get: (id) => store.get(id), holds: (id) => store.holds(id) },
		readings: { latest: readings.latest, payloads: readings.payloads, extremes: readings.extremes },
		flushReadings: readings.flush,
		close,
	};
}
