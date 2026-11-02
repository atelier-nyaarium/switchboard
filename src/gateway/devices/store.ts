import { z } from "zod";
import { commitChecked, type DurableStore, openDurable } from "../../shared/durable-store.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import {
	DEVICE_MAX_RECORDS,
	DeviceAddRequestSchema,
	DeviceAddressSchema,
	DeviceIdSchema,
	type DeviceRecord,
	DeviceRecordSchema,
	DeviceRevisionSchema,
	deviceNameRefusal,
	deviceRefusal,
} from "../../shared/schemasDevices.js";
import { REVISION_CEILING } from "../../shared/schemasRunbook.js";

export interface DeviceStoreDeps {
	store: Pick<DurableStore, "load" | "saveChecked">;
	onChanged: (deviceId: string) => void;
}

export interface DeviceWriteResult {
	stored: boolean;
	record?: DeviceRecord;
	reason?: string;
}

export interface DeviceRemoveResult {
	deleted: boolean;
	record?: DeviceRecord;
	reason?: string;
}

export interface DeviceRefreshResult {
	changed: boolean;
	record?: DeviceRecord;
	reason?: string;
}

export interface DeviceStoreOpenOptions {
	onChanged?: (deviceId: string) => void;
}

const PersistedDeviceRecordSchema = z.strictObject(DeviceRecordSchema.shape);
const DeviceTombstoneSchema = z.strictObject({ id: DeviceIdSchema, revision: DeviceRevisionSchema });

/** Oldest tombstones evicted. */
const DEVICE_MAX_TOMBSTONES = 256;

const DeviceSnapshotSchema = z
	.object({
		revision: z.number().int().nonnegative().max(REVISION_CEILING),
		records: z.array(PersistedDeviceRecordSchema).max(DEVICE_MAX_RECORDS),
		tombstones: z.array(DeviceTombstoneSchema).max(DEVICE_MAX_TOMBSTONES).optional(),
	})
	.strict();

type DeviceTombstone = z.infer<typeof DeviceTombstoneSchema>;
type DeviceSnapshot = { revision: number; records: DeviceRecord[]; tombstones: DeviceTombstone[] };

function frozen(record: DeviceRecord): DeviceRecord {
	return Object.freeze({ ...record });
}

function restore(store: DeviceStoreDeps["store"]): DeviceSnapshot {
	const snapshot = DeviceSnapshotSchema.parse(store.load() ?? { revision: 0, records: [] });
	const ids = new Set<string>();
	const records = snapshot.records.map((record) => {
		if (ids.has(record.id)) throw new Error(`${record.id} is stored twice`);
		ids.add(record.id);
		if (record.revision > snapshot.revision) throw new Error(`${record.id} is ahead of the device list revision`);
		const refusal = deviceRefusal(record);
		if (refusal) throw new Error(`${record.id}: ${refusal}`);
		return frozen(record);
	});
	const tombstones = snapshot.tombstones ?? [];
	for (const tombstone of tombstones) {
		if (ids.has(tombstone.id)) throw new Error(`${tombstone.id} is both held and deleted`);
		ids.add(tombstone.id);
		if (tombstone.revision > snapshot.revision)
			throw new Error(`${tombstone.id} is ahead of the device list revision`);
	}
	return { revision: snapshot.revision, records, tombstones };
}

/** Sole writer of the device file. */
export function createDeviceStore(deps: DeviceStoreDeps) {
	let snapshot = restore(deps.store);
	const fifo = createKeyedFifo<string>();

	const commit = (
		records: DeviceRecord[],
		revision: number,
		deviceId: string,
		tombstones: DeviceTombstone[] = snapshot.tombstones,
	): boolean =>
		commitChecked(
			deps.store,
			{ revision, records, tombstones },
			(landed) => {
				snapshot = {
					revision: landed.revision,
					records: landed.records.map(frozen),
					tombstones: landed.tombstones,
				};
			},
			{ label: "device", onLanded: () => deps.onChanged(deviceId) },
		).landed;

	const held = (id: string): DeviceRecord | undefined => snapshot.records.find((record) => record.id === id);

	const list = () => ({
		records: [...snapshot.records].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
		revision: snapshot.revision,
	});

	const get = (id: string): DeviceRecord | null => held(id) ?? null;

	const add = (request: z.input<typeof DeviceAddRequestSchema>): DeviceWriteResult => {
		const nameRefusal = deviceNameRefusal(request.name);
		if (nameRefusal) return { stored: false, reason: nameRefusal };
		const parsed = DeviceAddRequestSchema.safeParse(request);
		if (!parsed.success) return { stored: false, reason: "invalid device candidate" };
		const incoming = parsed.data;
		const current = held(incoming.mac);
		if (current) {
			// Repeated add: lost answer.
			const same = current.address === incoming.address && current.name === incoming.name;
			return same
				? { stored: true, record: current }
				: { stored: false, record: current, reason: "a device with that id is already stored" };
		}
		if (snapshot.records.length >= DEVICE_MAX_RECORDS) {
			return { stored: false, reason: `this Gateway holds ${DEVICE_MAX_RECORDS} devices already` };
		}
		if (snapshot.revision >= REVISION_CEILING)
			return { stored: false, reason: "the device list has no revision left" };
		const deleted = snapshot.tombstones.find((entry) => entry.id === incoming.mac);
		if (deleted && deleted.revision >= REVISION_CEILING) {
			return { stored: false, reason: "this device has no revision left to write" };
		}
		const record: DeviceRecord = {
			id: incoming.mac,
			name: incoming.name,
			kind: "switch",
			driver: "kasa",
			address: incoming.address,
			revision: (deleted?.revision ?? 0) + 1,
		};
		const refusal = deviceRefusal(record);
		if (refusal) return { stored: false, reason: refusal };
		const tombstones = snapshot.tombstones.filter((entry) => entry.id !== record.id);
		if (!commit([...snapshot.records, record], snapshot.revision + 1, record.id, tombstones)) {
			return { stored: false, reason: "could not be written" };
		}
		return { stored: true, record: held(record.id) };
	};

	const rename = (id: string, name: string, baseRevision: number): DeviceWriteResult => {
		const current = held(id);
		if (!current) return { stored: false, reason: "no device with that id is stored" };
		const nameRefusal = deviceNameRefusal(name);
		if (nameRefusal) return { stored: false, record: current, reason: nameRefusal };
		if (current.name === name && (baseRevision === current.revision || baseRevision + 1 === current.revision)) {
			return { stored: true, record: current };
		}
		if (current.revision !== baseRevision) {
			return {
				stored: false,
				record: current,
				reason: `revision ${current.revision} is stored; this edits ${baseRevision}`,
			};
		}
		if (current.name === name) return { stored: true, record: current };
		if (current.revision >= REVISION_CEILING || snapshot.revision >= REVISION_CEILING) {
			return { stored: false, record: current, reason: "this device has no revision left to write" };
		}
		const record = frozen({ ...current, name, revision: current.revision + 1 });
		if (
			!commit(
				snapshot.records.map((row) => (row.id === id ? record : row)),
				snapshot.revision + 1,
				id,
			)
		) {
			return { stored: false, record: current, reason: "could not be written" };
		}
		return { stored: true, record: held(id) };
	};

	const remove = (id: string, baseRevision: number): DeviceRemoveResult => {
		const current = held(id);
		if (!current) {
			const tombstone = snapshot.tombstones.find((entry) => entry.id === id);
			if (tombstone?.revision === baseRevision) return { deleted: true };
			return { deleted: false, reason: "no device with that id is stored" };
		}
		if (current.revision !== baseRevision) {
			return {
				deleted: false,
				record: current,
				reason: `revision ${current.revision} is stored; this deletes ${baseRevision}`,
			};
		}
		if (snapshot.revision >= REVISION_CEILING) {
			return { deleted: false, record: current, reason: "the device list has no revision left" };
		}
		const tombstones = [
			...snapshot.tombstones.filter((entry) => entry.id !== id),
			{ id, revision: current.revision },
		].slice(-DEVICE_MAX_TOMBSTONES);
		if (
			!commit(
				snapshot.records.filter((row) => row.id !== id),
				snapshot.revision + 1,
				id,
				tombstones,
			)
		) {
			return { deleted: false, record: current, reason: "could not be written" };
		}
		return { deleted: true };
	};

	const refreshAddress = (id: string, address: string): DeviceRefreshResult => {
		const current = held(id);
		if (!current) return { changed: false, reason: "no device with that id is stored" };
		const parsedAddress = DeviceAddressSchema.safeParse(address);
		if (!parsedAddress.success) return { changed: false, record: current, reason: "invalid IPv4 address" };
		if (current.address === parsedAddress.data) return { changed: false, record: current };
		if (current.revision >= REVISION_CEILING || snapshot.revision >= REVISION_CEILING) {
			return { changed: false, record: current, reason: "this device has no revision left to write" };
		}
		const record = frozen({ ...current, address: parsedAddress.data, revision: current.revision + 1 });
		if (
			!commit(
				snapshot.records.map((row) => (row.id === id ? record : row)),
				snapshot.revision + 1,
				id,
			)
		) {
			return { changed: false, record: current, reason: "could not be written" };
		}
		return { changed: true, record: held(id) };
	};

	const perDevice = <T>(id: string, work: () => T | PromiseLike<T>): Promise<T> => fifo.run(id, work);

	return { list, get, add, rename, remove, refreshAddress, perDevice };
}

export function openDeviceStore(dataDir: string, options: DeviceStoreOpenOptions = {}) {
	return openDurable(dataDir, "devices", (store) =>
		createDeviceStore({ store, onChanged: options.onChanged ?? (() => {}) }),
	);
}

export type DeviceStore = ReturnType<typeof createDeviceStore>;
