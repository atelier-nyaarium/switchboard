import type { z } from "zod";
import type { Ambient, Linked } from "../../shared/ambient.js";
import { linkedSignal } from "../../shared/ambient.js";
import {
	ConsoleDeviceAddResultSchema,
	ConsoleDeviceListResultSchema,
	ConsoleDeviceReadResultSchema,
	ConsoleDeviceRemoveResultSchema,
	ConsoleDeviceRenameResultSchema,
	ConsoleDeviceScanResultSchema,
	ConsoleDeviceSchedulePutResultSchema,
	ConsoleDeviceSetResultSchema,
	ConsoleDeviceSettingPutResultSchema,
	DeviceAddRequestSchema,
	type DeviceDriverSchema,
	type DeviceRecord,
	DeviceScheduleSchema,
	DeviceSettingPutSchema,
	DeviceVerbSchema,
	deviceNameRefusal,
	deviceRefusal,
	normalizeDeviceMac,
} from "../../shared/schemasDevices.js";
import type { PhoneAnswerOf, UnavailableReason } from "../../shared/schemasPhoneCapabilities.js";
import { REVISION_CEILING } from "../../shared/schemasRunbook.js";
import { ASSISTANT_WAITS } from "../assistant/waits.js";
import type { DeviceConsoleHandlers } from "../console/consoleTypes.js";
import type { DeviceDriverError, DeviceOperationContext, DeviceVerb } from "../devices/driver.js";
import { DeviceDriverFailure, sentOf } from "../devices/driver.js";
import { createKasaDriver } from "../devices/kasa/kasaDriver.js";
import { createKasaTransport, type KasaTransport } from "../devices/kasa/transport.js";
import { createDeviceScan, type KasaScanRelay } from "../devices/scan.js";
import { type DeviceStore, openDeviceStore } from "../devices/store.js";

type DeviceRead = Awaited<ReturnType<ReturnType<typeof createKasaDriver>["read"]>>;
type DeviceLink = Linked & { deadlineAt: number };
type DeviceOperationResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "failure"; failure: DeviceDriverError }
	| { kind: "missing" };
type SerializedDeviceOperationResult<T> = DeviceOperationResult<T> | { kind: "refused"; reason: string };

/** Per-plug bounds inside one action. */
export const DEVICE_IDENTIFY_WAIT_MS = 3_000;
export const DEVICE_READ_WAIT_MS = 5_000;

export type DeviceSetActionResult =
	| { kind: "ok"; answer: PhoneAnswerOf<"device_set"> }
	| { kind: "unavailable"; reason: UnavailableReason; detail?: string }
	| { kind: "refused"; reason: string };

export type DeviceListActionResult =
	| { kind: "ok"; answer: PhoneAnswerOf<"devices"> }
	| { kind: "unavailable"; reason: UnavailableReason; detail?: string };

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

function detailOf(error: unknown): string {
	if (error instanceof DeviceDriverFailure) {
		return error.failure.kind === "refused"
			? `err_code ${error.failure.code}: ${error.failure.message}`
			: error.failure.detail;
	}
	return error instanceof Error && error.message ? error.message : "device operation failed";
}

function boundedDetail(detail: string): string {
	return detail.slice(0, 400);
}

function failureOf(error: unknown, link: DeviceLink): DeviceDriverError {
	if (error instanceof DeviceDriverFailure) {
		if (error.failure.kind === "timeout" && error.failure.sent === false) return notStartedFailure();
		return error.failure;
	}
	if (link.signal.aborted) {
		return { kind: "timeout", detail: "the deadline passed; a sent command's outcome is unknown" };
	}
	return { kind: "unreachable", detail: detailOf(error) };
}

function notStartedFailure(): Extract<DeviceDriverError, { kind: "timeout" }> {
	return { kind: "timeout", detail: "not started before the deadline" };
}

function operationReason(failure: DeviceDriverError): z.infer<typeof ConsoleDeviceReadResultSchema.shape.reason> {
	return failure.kind;
}

function candidatesText(label: string, records: readonly DeviceRecord[]): string {
	const head = `${label}. Candidates: `;
	if (records.length === 0) return `${head}none`.slice(0, 400);
	let answer = head;
	let added = 0;
	for (const record of records) {
		const item = `${record.name} (${record.id})`;
		const separator = added === 0 ? "" : ", ";
		const remaining = records.length - added - 1;
		const suffix = remaining > 0 ? `, and ${remaining} more` : "";
		if (answer.length + separator.length + item.length + suffix.length > 400) {
			answer += `${added === 0 ? "" : ", "}and ${records.length - added} more`;
			break;
		}
		answer += `${separator}${item}`;
		added += 1;
	}
	return answer.slice(0, 400);
}

function driverFor(
	drivers: Readonly<Record<z.infer<typeof DeviceDriverSchema>, ReturnType<typeof createKasaDriver>>>,
	record: DeviceRecord,
) {
	const driver = drivers[record.driver];
	const refusal = deviceRefusal(record);
	if (refusal) throw new Error(refusal);
	return driver;
}

export function composeDevices(deps: DeviceStageDeps): DeviceStage {
	const drivers = {
		kasa: createKasaDriver({ transport: deps.transport ?? createKasaTransport() }),
	} satisfies Readonly<Record<z.infer<typeof DeviceDriverSchema>, ReturnType<typeof createKasaDriver>>>;
	const store =
		deps.deviceStore ?? openDeviceStore(deps.dataDir, { onChanged: (deviceId) => deps.onChanged?.(deviceId) });
	const runScan = createDeviceScan(deps.relayToHost);
	const stageController = new AbortController();
	const activeOperations = new Set<Promise<void>>();
	const unknownToggleOutcome = new Set<string>();
	let closePromise: Promise<void> | null = null;

	const newLink = (): DeviceLink => {
		const deadlineAt = deps.ambient.now() + ASSISTANT_WAITS.action;
		const link = linkedSignal(deps.ambient, {
			parent: stageController.signal,
			ms: ASSISTANT_WAITS.action,
			reason: "device deadline",
		});
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		activeOperations.add(settled);
		return {
			...link,
			deadlineAt,
			dispose: () => {
				link.dispose();
				activeOperations.delete(settled);
				settle();
			},
		};
	};

	const nested = (link: DeviceLink, ms: number): DeviceLink => {
		const inner = linkedSignal(deps.ambient, { parent: link.signal, ms, reason: "device deadline" });
		return { ...inner, deadlineAt: Math.min(link.deadlineAt, deps.ambient.now() + ms) };
	};

	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		stageController.abort("device stage closed");
		closePromise = (async () => {
			while (activeOperations.size > 0) await Promise.all([...activeOperations]);
		})();
		return closePromise;
	};

	const endIfDeadlinePassed = (link: DeviceLink): boolean => {
		if (!link.signal.aborted && deps.ambient.now() >= link.deadlineAt) link.end("device deadline");
		return link.signal.aborted;
	};

	const underLink = async <T>(
		link: DeviceLink,
		work: (context: DeviceOperationContext) => Promise<T>,
	): Promise<Exclude<DeviceOperationResult<T>, { kind: "missing" }>> => {
		if (endIfDeadlinePassed(link)) {
			return { kind: "failure", failure: notStartedFailure() };
		}
		try {
			return { kind: "ok", value: await work({ ambient: deps.ambient, signal: link.signal }) };
		} catch (error) {
			return { kind: "failure", failure: failureOf(error, link) };
		}
	};

	const serialized = <T>(
		id: string,
		link: DeviceLink,
		work: (record: DeviceRecord, context: DeviceOperationContext) => Promise<T>,
		refuse?: (record: DeviceRecord) => string | null,
		after?: (result: DeviceOperationResult<T>, record: DeviceRecord) => void,
	): Promise<SerializedDeviceOperationResult<T>> => {
		if (endIfDeadlinePassed(link)) return Promise.resolve({ kind: "failure", failure: notStartedFailure() });
		return store.perDevice(id, async () => {
			if (endIfDeadlinePassed(link)) {
				return { kind: "failure", failure: notStartedFailure() };
			}
			const record = store.get(id);
			if (!record) return { kind: "missing" };
			const reason = refuse?.(record);
			if (reason) return { kind: "refused", reason };
			const result = await underLink(link, (context) => work(record, context));
			after?.(result, record);
			return result;
		});
	};

	const readDevice = async (id: string): Promise<SerializedDeviceOperationResult<DeviceRead>> => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) return { kind: "failure", failure: notStartedFailure() };
			return await serialized(
				id,
				link,
				(record, context) => driverFor(drivers, record).read(record, context),
				undefined,
				(result) => {
					if (result.kind === "ok") unknownToggleOutcome.delete(id);
				},
			);
		} finally {
			link.dispose();
		}
	};

	const setDeviceById = async (
		id: string,
		verb: DeviceVerb,
		providedLink?: DeviceLink,
	): Promise<SerializedDeviceOperationResult<Awaited<ReturnType<ReturnType<typeof createKasaDriver>["set"]>>>> => {
		const link = providedLink ?? newLink();
		try {
			if (endIfDeadlinePassed(link)) return { kind: "failure", failure: notStartedFailure() };
			return await serialized(
				id,
				link,
				(record, context) => driverFor(drivers, record).set(record, verb, context),
				() =>
					verb === "toggle" && unknownToggleOutcome.has(id)
						? "read the device first; the last toggle's outcome is unknown"
						: null,
				(result) => {
					if (verb === "toggle" && result.kind === "failure" && sentOf(result.failure)) {
						unknownToggleOutcome.add(id);
					} else if (verb !== "toggle" && result.kind === "ok") {
						unknownToggleOutcome.delete(id);
					}
				},
			);
		} finally {
			if (!providedLink) link.dispose();
		}
	};

	const list: DeviceConsoleHandlers["list"] = async () => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceListResultSchema.parse({ reason: "timeout", detail: notStartedFailure().detail });
			}
			return store.list();
		} finally {
			link.dispose();
		}
	};
	const read: DeviceConsoleHandlers["read"] = async (id) => {
		const result = await readDevice(id);
		if (result.kind === "ok") {
			return ConsoleDeviceReadResultSchema.parse({ state: result.value.state, schedule: result.value.schedule });
		}
		if (result.kind === "missing") {
			return ConsoleDeviceReadResultSchema.parse({
				reason: "not_supported",
				detail: "no device with that id is stored",
			});
		}
		if (result.kind === "refused") {
			return ConsoleDeviceReadResultSchema.parse({ reason: "not_supported", detail: result.reason });
		}
		return ConsoleDeviceReadResultSchema.parse({
			reason: operationReason(result.failure),
			detail: boundedDetail(detailOf(new DeviceDriverFailure(result.failure))),
		});
	};
	const add: DeviceConsoleHandlers["add"] = async (request) => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceAddResultSchema.parse({
					stored: false,
					reason: notStartedFailure().kind,
					detail: notStartedFailure().detail,
				});
			}
			const parsed = DeviceAddRequestSchema.safeParse(request);
			if (!parsed.success) {
				return ConsoleDeviceAddResultSchema.parse({
					stored: false,
					reason: deviceNameRefusal(request.name) ?? "invalid device candidate",
				});
			}
			return await store.perDevice(parsed.data.mac, async () => {
				if (endIfDeadlinePassed(link)) {
					return ConsoleDeviceAddResultSchema.parse({
						stored: false,
						reason: notStartedFailure().kind,
						detail: notStartedFailure().detail,
					});
				}
				const current = store.get(parsed.data.mac);
				if (current && current.address === parsed.data.address && current.name === parsed.data.name) {
					return ConsoleDeviceAddResultSchema.parse({ stored: true, record: current });
				}
				if (endIfDeadlinePassed(link)) {
					const failure = notStartedFailure();
					return ConsoleDeviceAddResultSchema.parse({
						stored: false,
						reason: failure.kind,
						detail: failure.detail,
					});
				}
				const driver = drivers.kasa;
				const identified = await underLink(link, (context) => driver.identify(parsed.data.address, context));
				if (identified.kind === "failure") {
					return ConsoleDeviceAddResultSchema.parse({
						stored: false,
						reason: identified.failure.kind,
						detail: boundedDetail(detailOf(new DeviceDriverFailure(identified.failure))),
					});
				}
				if (identified.value !== parsed.data.mac) {
					return ConsoleDeviceAddResultSchema.parse({
						stored: false,
						reason: `address answers ${identified.value}; expected ${parsed.data.mac}`,
					});
				}
				const result = store.add({ ...parsed.data, mac: identified.value });
				return ConsoleDeviceAddResultSchema.parse(result);
			});
		} finally {
			link.dispose();
		}
	};
	const rename: DeviceConsoleHandlers["rename"] = async (id, name, revision) => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceRenameResultSchema.parse({
					stored: false,
					reason: notStartedFailure().kind,
					detail: notStartedFailure().detail,
				});
			}
			return await store.perDevice(id, async () => {
				if (endIfDeadlinePassed(link)) {
					return ConsoleDeviceRenameResultSchema.parse({
						stored: false,
						reason: notStartedFailure().kind,
						detail: notStartedFailure().detail,
					});
				}
				const record = store.get(id);
				if (
					!record ||
					deviceNameRefusal(name) !== null ||
					record.name === name ||
					record.revision !== revision ||
					record.revision >= REVISION_CEILING ||
					store.list().revision >= REVISION_CEILING
				) {
					return ConsoleDeviceRenameResultSchema.parse(store.rename(id, name, revision));
				}
				if (endIfDeadlinePassed(link)) {
					return ConsoleDeviceRenameResultSchema.parse({
						stored: false,
						record,
						reason: notStartedFailure().kind,
						detail: notStartedFailure().detail,
					});
				}
				const result = await underLink(link, (context) =>
					driverFor(drivers, record).rename(record, name, context),
				);
				if (result.kind === "failure") {
					return ConsoleDeviceRenameResultSchema.parse({
						stored: false,
						record,
						reason: result.failure.kind,
						detail: boundedDetail(detailOf(new DeviceDriverFailure(result.failure))),
					});
				}
				const committed = store.rename(id, name, revision);
				if (!committed.stored) {
					const previous = result.value.previous ?? record.name;
					const restored = await underLink(link, (context) =>
						driverFor(drivers, record).rename(record, previous, context),
					);
					if (restored.kind === "failure") {
						return ConsoleDeviceRenameResultSchema.parse({
							...committed,
							detail: `the plug may still be named ${name}`,
						});
					}
				}
				return ConsoleDeviceRenameResultSchema.parse(committed);
			});
		} finally {
			link.dispose();
		}
	};
	const remove: DeviceConsoleHandlers["remove"] = async (id, revision) => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceRemoveResultSchema.parse({
					deleted: false,
					reason: notStartedFailure().kind,
					detail: notStartedFailure().detail,
				});
			}
			return await store.perDevice(id, () => {
				if (endIfDeadlinePassed(link)) {
					return ConsoleDeviceRemoveResultSchema.parse({
						deleted: false,
						reason: notStartedFailure().kind,
						detail: notStartedFailure().detail,
					});
				}
				const result = store.remove(id, revision);
				if (result.deleted) unknownToggleOutcome.delete(id);
				return ConsoleDeviceRemoveResultSchema.parse(result);
			});
		} finally {
			link.dispose();
		}
	};
	const set: DeviceConsoleHandlers["set"] = async (id, verb) => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceSetResultSchema.parse({
					reason: "timeout",
					detail: notStartedFailure().detail,
				});
			}
			const parsed = DeviceVerbSchema.safeParse(verb);
			if (!parsed.success)
				return ConsoleDeviceSetResultSchema.parse({ reason: "not_supported", detail: "invalid device verb" });
			const result = await setDeviceById(id, parsed.data, link);
			if (result.kind === "ok") return ConsoleDeviceSetResultSchema.parse({ state: result.value });
			if (result.kind === "refused")
				return ConsoleDeviceSetResultSchema.parse({ reason: "refused", detail: result.reason });
			if (result.kind === "missing") {
				return ConsoleDeviceSetResultSchema.parse({
					reason: "not_supported",
					detail: "no device with that id is stored",
				});
			}
			return ConsoleDeviceSetResultSchema.parse({
				reason: operationReason(result.failure),
				detail: boundedDetail(detailOf(new DeviceDriverFailure(result.failure))),
			});
		} finally {
			link.dispose();
		}
	};
	const schedulePut: DeviceConsoleHandlers["schedulePut"] = async (id, revision, schedule) => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceSchedulePutResultSchema.parse({
					reason: notStartedFailure().kind,
					detail: notStartedFailure().detail,
				});
			}
			const checked = DeviceScheduleSchema.safeParse(schedule);
			if (!checked.success) return ConsoleDeviceSchedulePutResultSchema.parse({ reason: "invalid schedule" });
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceSchedulePutResultSchema.parse({
					reason: notStartedFailure().kind,
					detail: notStartedFailure().detail,
				});
			}
			const result = await store.perDevice(id, async () => {
				if (endIfDeadlinePassed(link)) return { kind: "failure" as const, failure: notStartedFailure() };
				const record = store.get(id);
				if (!record) return { kind: "missing" as const };
				if (record.revision !== revision)
					return {
						kind: "stale" as const,
						record,
						reason: `revision ${record.revision} is stored; this edits ${revision}`,
					};
				const result = await underLink(link, (context) =>
					driverFor(drivers, record).schedule(record, context).put(checked.data),
				);
				return result.kind === "ok"
					? { kind: "ok" as const, schedule: result.value }
					: { kind: "failure" as const, record, failure: result.failure };
			});
			if (result.kind === "ok") return ConsoleDeviceSchedulePutResultSchema.parse({ schedule: result.schedule });
			if (result.kind === "stale") return ConsoleDeviceSchedulePutResultSchema.parse(result);
			if (result.kind === "missing")
				return ConsoleDeviceSchedulePutResultSchema.parse({ reason: "no device with that id is stored" });
			return ConsoleDeviceSchedulePutResultSchema.parse({
				record: result.record,
				reason: result.failure.kind,
				detail: boundedDetail(detailOf(new DeviceDriverFailure(result.failure))),
			});
		} finally {
			link.dispose();
		}
	};
	const settingPut: DeviceConsoleHandlers["settingPut"] = async (id, revision, setting) => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceSettingPutResultSchema.parse({
					reason: notStartedFailure().kind,
					detail: notStartedFailure().detail,
				});
			}
			const checked = DeviceSettingPutSchema.safeParse(setting);
			if (!checked.success)
				return ConsoleDeviceSettingPutResultSchema.parse({ reason: "invalid device setting" });
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceSettingPutResultSchema.parse({
					reason: notStartedFailure().kind,
					detail: notStartedFailure().detail,
				});
			}
			const result = await store.perDevice(id, async () => {
				if (endIfDeadlinePassed(link)) return { kind: "failure" as const, failure: notStartedFailure() };
				const record = store.get(id);
				if (!record) return { kind: "missing" as const };
				if (record.revision !== revision)
					return {
						kind: "stale" as const,
						record,
						reason: `revision ${record.revision} is stored; this edits ${revision}`,
					};
				const result = await underLink(link, (context) =>
					driverFor(drivers, record).settings(record, context).put(checked.data),
				);
				return result.kind === "ok"
					? { kind: "ok" as const, settings: result.value }
					: { kind: "failure" as const, record, failure: result.failure };
			});
			if (result.kind === "ok") return ConsoleDeviceSettingPutResultSchema.parse({ settings: result.settings });
			if (result.kind === "stale") return ConsoleDeviceSettingPutResultSchema.parse(result);
			if (result.kind === "missing")
				return ConsoleDeviceSettingPutResultSchema.parse({ reason: "no device with that id is stored" });
			return ConsoleDeviceSettingPutResultSchema.parse({
				record: result.record,
				reason: result.failure.kind,
				detail: boundedDetail(detailOf(new DeviceDriverFailure(result.failure))),
			});
		} finally {
			link.dispose();
		}
	};

	const listDevices: DeviceStage["listDevices"] = async () => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return { kind: "unavailable", reason: "timeout", detail: notStartedFailure().detail };
			}
			const records = store.list().records;
			const devices = await Promise.all(
				records.map(async (original) => {
					const bound = nested(link, DEVICE_READ_WAIT_MS);
					const result = await serialized(
						original.id,
						bound,
						async (record, context) => ({
							record,
							read: await driverFor(drivers, record).read(record, context),
						}),
						undefined,
						(result) => {
							if (result.kind === "ok") unknownToggleOutcome.delete(original.id);
						},
					).finally(() => bound.dispose());
					if (result.kind === "missing" || result.kind === "refused") return null;
					if (result.kind === "failure") {
						return {
							id: original.id,
							name: original.name,
							kind: original.kind,
							state:
								result.failure.kind === "unreachable" ? ("unreachable" as const) : ("unknown" as const),
						};
					}
					return {
						id: result.value.record.id,
						name: result.value.record.name,
						kind: result.value.record.kind,
						state: result.value.read.state.state,
					};
				}),
			);
			return {
				kind: "ok",
				answer: { devices: devices.filter((device): device is NonNullable<typeof device> => device !== null) },
			};
		} finally {
			link.dispose();
		}
	};

	const setDevice: DeviceStage["setDevice"] = async (target, verb) => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return { kind: "unavailable", reason: "timeout", detail: notStartedFailure().detail };
			}
			const records = store.list().records;
			const byId = store.get(normalizeDeviceMac(target) ?? target);
			const matches = byId
				? [byId]
				: records.filter((record) => record.name.toLowerCase() === target.toLowerCase());
			if (matches.length !== 1) {
				const ambiguous = matches.length > 1;
				return {
					kind: "refused",
					reason: candidatesText(
						ambiguous ? `"${target}" matches more than one device` : `no paired device matches "${target}"`,
						ambiguous ? matches : records,
					),
				};
			}
			const id = matches[0]!.id;
			const result = await setDeviceById(id, verb, link);
			if (result.kind === "ok") return { kind: "ok", answer: { id, state: result.value.state } };
			if (result.kind === "refused") return result;
			if (result.kind === "missing") {
				return {
					kind: "refused",
					reason: candidatesText(`no paired device matches "${target}"`, store.list().records),
				};
			}
			if (result.failure.kind === "unreachable" || result.failure.kind === "timeout") {
				return {
					kind: "unavailable",
					reason: result.failure.kind,
					detail: boundedDetail(result.failure.detail),
				};
			}
			return {
				kind: "refused",
				reason:
					result.failure.kind === "refused"
						? `the device answered err_code ${result.failure.code}`
						: boundedDetail(detailOf(new DeviceDriverFailure(result.failure))),
			};
		} finally {
			link.dispose();
		}
	};

	const scan: DeviceConsoleHandlers["scan"] = async () => {
		const link = newLink();
		try {
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceScanResultSchema.parse({ reason: "timeout", detail: notStartedFailure().detail });
			}
			const result = await runScan();
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceScanResultSchema.parse({ reason: "timeout", detail: notStartedFailure().detail });
			}
			for (const candidate of result.candidates ?? []) {
				if (endIfDeadlinePassed(link)) {
					return ConsoleDeviceScanResultSchema.parse({
						reason: "timeout",
						detail: notStartedFailure().detail,
					});
				}
				const refresh = await store.perDevice(candidate.mac, async () => {
					if (endIfDeadlinePassed(link)) return "not-started" as const;
					const current = store.get(candidate.mac);
					if (!current || current.address === candidate.address) return "done" as const;
					const bound = nested(link, DEVICE_IDENTIFY_WAIT_MS);
					const identified = await underLink(bound, (context) =>
						driverFor(drivers, current).identify(candidate.address, context),
					).finally(() => bound.dispose());
					if (identified.kind !== "ok" || identified.value !== current.id) return "done" as const;
					if (endIfDeadlinePassed(link)) return "not-started" as const;
					const latest = store.get(candidate.mac);
					if (latest?.id === identified.value && latest.address !== candidate.address) {
						store.refreshAddress(candidate.mac, candidate.address);
					}
					return "done" as const;
				});
				if (refresh === "not-started") {
					return ConsoleDeviceScanResultSchema.parse({
						reason: "timeout",
						detail: notStartedFailure().detail,
					});
				}
			}
			if (endIfDeadlinePassed(link)) {
				return ConsoleDeviceScanResultSchema.parse({ reason: "timeout", detail: notStartedFailure().detail });
			}
			return result;
		} finally {
			link.dispose();
		}
	};

	const console: DeviceConsoleHandlers = { list, read, scan, add, rename, remove, set, schedulePut, settingPut };
	return { console, listDevices, setDevice, close };
}
