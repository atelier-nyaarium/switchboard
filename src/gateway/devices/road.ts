import type { z } from "zod";
import { type Ambient, type Linked, linkedSignal } from "../../shared/ambient.js";
import { CONSOLE_ANSWER_WAIT_MS, CONSOLE_HOP_MARGIN_MS } from "../../shared/console-protocol.js";
import { type DeviceAddRequestSchema, type DeviceRecord, deviceRefusal } from "../../shared/schemasDevices.js";
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
import {
	type DeviceRefreshResult,
	type DeviceRemoveResult,
	type DeviceStore,
	type DeviceWriteResult,
	openDeviceStore,
} from "./store.js";

export const TOGGLE_DOUBT = "read the device first; the last toggle's outcome is unknown";

export type Surface = "console" | "assistant";
export type Effect = "none" | "unknown";
export type DeviceEffect = "confirms-relay" | "toggles-relay";

export type Declined =
	| { kind: "notStarted" }
	| { kind: "missing" }
	| { kind: "refused"; text: string; record?: DeviceRecord }
	| { kind: "stale"; record: DeviceRecord; text: string }
	| { kind: "failed"; failure: DeviceDriverError; effect: Effect; record?: DeviceRecord };

export type Outcome<T> = { ok: true; value: T } | { ok: false; why: Declined };

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

export interface DeviceWrites {
	add(request: z.input<typeof DeviceAddRequestSchema>): DeviceWriteResult;
	rename(name: string, baseRevision: number): DeviceWriteResult;
	remove(baseRevision: number): DeviceRemoveResult;
	refreshAddress(address: string): DeviceRefreshResult;
}

export interface Slot {
	readonly id: string;
	readonly record: DeviceRecord | null;
	readonly write: DeviceWrites;
	drive<T>(work: (ctx: DeviceOperationContext) => Promise<T>, effect?: DeviceEffect): Promise<T>;
	/** Compensation only. */
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
	reads: { list(): ReturnType<DeviceStore["list"]>; get(id: string): DeviceRecord | null };
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

/** The one road to a store or a driver. */
export function createDeviceRoad(deps: DeviceRoadDeps): DeviceRoad {
	const store =
		deps.deviceStore ?? openDeviceStore(deps.dataDir, { onChanged: (deviceId) => deps.onChanged?.(deviceId) });
	const drivers: Readonly<Record<DeviceRecord["driver"], DeviceDriver>> = {
		kasa: createKasaDriver({ transport: deps.transport ?? createKasaTransport() }),
	};
	const stage = new AbortController();
	const leases = new Set<Promise<void>>();
	const doubt = new Set<string>();
	let closing: Promise<void> | null = null;

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
		const driver = drivers[record?.driver ?? "kasa"];
		const slot: Slot = {
			id,
			record,
			write: {
				add: (request) => store.add(request),
				rename: (name, baseRevision) => store.rename(id, name, baseRevision),
				remove: (baseRevision) => {
					const result = store.remove(id, baseRevision);
					if (result.deleted) doubt.delete(id);
					return result;
				},
				refreshAddress: (address) => store.refreshAddress(id, address),
			},
			async drive(work, effect) {
				if (expired(held)) throw new Decline(NOT_STARTED);
				if (effect === "toggles-relay" && doubt.has(id)) {
					throw new Decline(withRecord({ kind: "refused", text: TOGGLE_DOUBT }, record));
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
							{ kind: "refused", text: `address answers ${actual}; expected ${expected}` },
							record,
						),
					);
				}
			},
			expect(revision) {
				if (record && record.revision !== revision) {
					throw new Decline({
						kind: "stale",
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
							if (!slot.record) return { ok: false, why: { kind: "missing" } };
							const refusal = deviceRefusal(slot.record);
							if (refusal)
								return { ok: false, why: { kind: "refused", text: refusal, record: slot.record } };
							const plug: Plug = { ...slot, record: slot.record, driver: drivers[slot.record.driver] };
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

	const unwrap = <T>(outcome: Outcome<T>): T => {
		if (!outcome.ok) throw new Decline(outcome.why);
		return outcome.value;
	};

	const close = (): Promise<void> => {
		if (closing) return closing;
		stage.abort("device stage closed");
		closing = (async () => {
			while (leases.size > 0) await Promise.all([...leases]);
		})();
		return closing;
	};

	return {
		operation,
		onSlot: (surface, shape, id, run) => operation(surface, shape, async (op) => unwrap(await op.device(id, run))),
		onDevice: (surface, shape, id, run) => operation(surface, shape, async (op) => unwrap(await op.plug(id, run))),
		reads: { list: () => store.list(), get: (id) => store.get(id) },
		close,
	};
}
