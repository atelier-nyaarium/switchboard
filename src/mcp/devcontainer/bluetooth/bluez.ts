import type { Advert } from "../../../shared/ble-recognition.js";
import { HOST_BLE_SCAN_MAX_DEVICES, type HostBleScanResult, HostBleScanResultSchema } from "../../../shared/host-op.js";
import type { DbusClient } from "./dbusClient.js";
import { createSystemBusClient, DbusCallError, DbusConnectionError } from "./dbusClient.js";
import type { DbusMessage, DbusValue, DbusVariant } from "./dbusWire.js";

const DBUS_NAME = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const BLUEZ_NAME = "org.bluez";
const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";
const ADAPTER = "org.bluez.Adapter1";
const DEVICE = "org.bluez.Device1";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const DEFAULT_SCAN_WINDOW_MS = 8_000;
const MAX_SCAN_WINDOW_MS = 8_000;
const SCAN_READY_TIMEOUT_MS = 2_000;
const STABLE_MS = 5_000;
const MAX_ADDRESSES = HOST_BLE_SCAN_MAX_DEVICES;
const MAX_MANUFACTURERS = 32;
const MAX_MANUFACTURER_BYTES = 64;
const MAX_SERVICES = 64;
const MATCH_RULES = [
	"type='signal',sender='org.bluez',interface='org.freedesktop.DBus.ObjectManager',member='InterfacesAdded',path='/'",
	"type='signal',sender='org.bluez',interface='org.freedesktop.DBus.ObjectManager',member='InterfacesRemoved',path='/'",
	"type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',arg0='org.bluez.Device1'",
	"type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',arg0='org.bluez.Adapter1'",
	"type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.bluez'",
];

export interface DiscoveryFilter {
	[key: string]: DbusVariant;
}

export interface BluezClock {
	now(): number;
	schedule(delayMs: number, callback: () => void): () => void;
}

export interface BluezCoordinatorOptions {
	clientFactory?: () => DbusClient;
	clock?: BluezClock;
}

export interface BluezObservation {
	mac: string;
	signal: number;
	advert: Advert;
	at: number;
}

export type DiscoveryReady = "discovering" | "no_radio" | "failed";

export interface DiscoveryHold {
	update(filter: DiscoveryFilter): void;
	release(): void;
	ready(timeoutMs: number): Promise<DiscoveryReady>;
}

interface HeardDevice {
	mac: string;
	name?: string;
	signal: number;
	data: Record<string, string>;
	services: Set<string>;
}

interface UpLink {
	phase: "up";
	epoch: number;
	adapter: string;
	powered: boolean;
	devices: Map<string, Map<string, DbusValue>>;
	discovery: "off" | "on" | "unknown";
	filter: string | null;
}

type Link = { phase: "down"; failures: number } | UpLink | { phase: "closed" };

interface Scheduled {
	cancel: () => void;
}

interface ReadyWaiter {
	token: symbol;
	finish(result: DiscoveryReady): void;
}

export class BluezNoRadioError extends Error {
	constructor() {
		super("Bluetooth adapter unavailable");
		this.name = "BluezNoRadioError";
	}
}

export interface BluezCoordinator {
	hold(filter?: DiscoveryFilter): DiscoveryHold;
	onObservation(listener: (observation: BluezObservation) => void): () => void;
	scan(windowMs?: number): Promise<HostBleScanResult>;
	close(): void;
}

function mapOf(value: DbusValue | undefined): Map<DbusValue, DbusValue> {
	if (value instanceof Map) return value;
	if (typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array))
		return new Map(Object.entries(value));
	return new Map();
}

function unwrap(value: DbusValue | undefined): DbusValue | undefined {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Uint8Array) &&
		"signature" in value &&
		"value" in value
	)
		return (value as DbusVariant).value;
	return value;
}

function dbusErrorIsNoRadio(error: unknown): boolean {
	if (error instanceof BluezNoRadioError || error instanceof DbusConnectionError) return true;
	if (error instanceof DbusCallError) {
		return [
			"org.freedesktop.DBus.Error.ServiceUnknown",
			"org.freedesktop.DBus.Error.NameHasNoOwner",
			"org.freedesktop.DBus.Error.NoReply",
		].includes(error.errorName);
	}
	return false;
}

function dbusErrorIsInProgress(error: unknown): boolean {
	return error instanceof DbusCallError && error.errorName === "org.bluez.Error.InProgress";
}

function dbusErrorIsNoDiscoveryStarted(error: unknown): boolean {
	return error instanceof DbusCallError && error.message === "No discovery started";
}

function normalizeMac(value: DbusValue | undefined): string | null {
	if (typeof value !== "string") return null;
	const mac = value.toLowerCase();
	return /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) ? mac : null;
}

function manufacturerEntries(value: DbusValue | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [company, payloadValue] of mapOf(unwrap(value))) {
		if (typeof company !== "number" || !Number.isInteger(company) || company < 0 || company > 65535) continue;
		if (Object.keys(result).length >= MAX_MANUFACTURERS) break;
		const payload = unwrap(payloadValue);
		const bytes = payload instanceof Uint8Array ? [...payload] : Array.isArray(payload) ? payload : [];
		const hex = bytes
			.slice(0, MAX_MANUFACTURER_BYTES)
			.filter(
				(byte): byte is number =>
					typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
			)
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		result[String(company)] = hex;
	}
	return result;
}

function serviceIds(value: DbusValue | undefined): string[] {
	if (!Array.isArray(value)) return [];
	const services = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const match = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(item);
		if (match) services.add(match[1].toLowerCase());
		if (services.size >= MAX_SERVICES) break;
	}
	return [...services];
}

function macForPath(path: string): string | null {
	const match = /\/dev_([0-9a-f]{2}(?:_[0-9a-f]{2}){5})$/i.exec(path);
	return match ? match[1].replaceAll("_", ":").toLowerCase() : null;
}

function rememberProperties(
	properties: Map<string, Map<string, DbusValue>>,
	path: string,
	values: Map<string, DbusValue>,
): void {
	if (!properties.has(path) && properties.size >= MAX_ADDRESSES) {
		const oldest = properties.keys().next().value;
		if (oldest !== undefined) properties.delete(oldest);
	}
	properties.set(path, values);
}

function variant(signature: string, value: DbusValue): DbusVariant {
	return { signature, value };
}

function same(a: DbusValue, b: DbusValue): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((item, index) => same(item, b[index]));
	return false;
}

function unionFilters(filters: Iterable<DiscoveryFilter>): Map<string, DbusVariant> {
	const result = new Map<string, DbusVariant>();
	const conflicts = new Set<string>();
	for (const filter of filters) {
		for (const [key, item] of Object.entries(filter)) {
			if (key === "Transport" || conflicts.has(key)) continue;
			const prior = result.get(key);
			if (!prior) {
				result.set(key, item);
				continue;
			}
			if (key === "DuplicateData" || key === "Discoverable") {
				result.set(key, variant("b", prior.value === true || item.value === true));
			} else if (Array.isArray(prior.value) && Array.isArray(item.value) && prior.signature === item.signature) {
				const values = [...prior.value];
				for (const value of item.value) if (!values.some((seen) => same(seen, value))) values.push(value);
				result.set(key, variant(prior.signature, values));
			} else if (key === "RSSI" && typeof prior.value === "number" && typeof item.value === "number") {
				result.set(key, variant("n", Math.min(prior.value, item.value)));
			} else if (key === "Pathloss" && typeof prior.value === "number" && typeof item.value === "number") {
				result.set(key, variant("q", Math.max(prior.value, item.value)));
			} else if (prior.signature !== item.signature || !same(prior.value, item.value)) {
				result.delete(key);
				conflicts.add(key);
			}
		}
	}
	result.set("Transport", variant("s", "le"));
	return result;
}

function canonical(value: DbusValue): string {
	if (typeof value === "bigint") return `bigint:${value}`;
	if (value instanceof Uint8Array) return `bytes:${[...value].join(",")}`;
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value instanceof Map) {
		const entries = [...value.entries()]
			.map(([key, item]) => [canonical(key), canonical(item)] as const)
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, item]) => `${key}:${item}`).join(",")}}`;
	}
	if (typeof value === "object" && value !== null) {
		if ("signature" in value && "value" in value) return `variant:${value.signature}:${canonical(value.value)}`;
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${key}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function unionFilterKey(filters: Iterable<DiscoveryFilter>): string {
	return canonical(unionFilters(filters));
}

function combineHeard(target: Map<string, HeardDevice>, observation: BluezObservation): void {
	let current = target.get(observation.mac);
	if (!current) {
		if (target.size >= MAX_ADDRESSES) return;
		current = {
			mac: observation.mac,
			name: observation.advert.name,
			signal: observation.signal,
			data: {},
			services: new Set(),
		};
		target.set(observation.mac, current);
	}
	if (observation.advert.name) current.name = observation.advert.name;
	current.signal = observation.signal;
	for (const [company, payload] of Object.entries(observation.advert.data)) current.data[company] = payload;
	for (const service of observation.advert.services) {
		if (current.services.size >= MAX_SERVICES) break;
		current.services.add(service);
	}
}

const defaultClock: BluezClock = {
	now: () => Date.now(),
	schedule: (delayMs, callback) => {
		const timer = setTimeout(callback, delayMs);
		return () => clearTimeout(timer);
	},
};

/** One reconcile loop calls BlueZ. */
export function createBluezCoordinator(options: BluezCoordinatorOptions = {}): BluezCoordinator {
	const clientFactory = options.clientFactory ?? createSystemBusClient;
	const clock = options.clock ?? defaultClock;
	const holds = new Map<symbol, DiscoveryFilter>();
	const observationListeners = new Set<(observation: BluezObservation) => void>();
	const readyWaiters = new Set<ReadyWaiter>();
	let link: Link = { phase: "down", failures: 0 };
	let client: DbusClient | null = null;
	let connectingClient: DbusClient | null = null;
	let connectingSignals: DbusMessage[] = [];
	let removeClientListeners: (() => void) | null = null;
	let nextEpoch = 1;
	let dirty = false;
	let running = false;
	let retryTimer: Scheduled | null = null;
	let retryReady = false;
	let stableTimer: { epoch: number; scheduled: Scheduled } | null = null;
	let lastFailure: DiscoveryReady | null = null;
	let failureCount = 0;

	function cancelRetry(): void {
		retryTimer?.cancel();
		retryTimer = null;
		retryReady = false;
	}

	function cancelStable(): void {
		stableTimer?.scheduled.cancel();
		stableTimer = null;
	}

	function currentFilterKey(): string {
		return unionFilterKey(holds.values());
	}

	function copyFilter(filter: DiscoveryFilter): DiscoveryFilter {
		try {
			return { ...filter };
		} catch {
			return {};
		}
	}

	function isClosed(): boolean {
		return link.phase === "closed";
	}

	function readiness(token: symbol): DiscoveryReady | null {
		if (link.phase === "closed" || !holds.has(token)) return "failed";
		if (link.phase === "up" && link.powered && link.discovery === "on" && link.filter === currentFilterKey())
			return "discovering";
		return lastFailure;
	}

	function settleReady(): void {
		for (const waiter of readyWaiters) {
			const result = readiness(waiter.token);
			if (result) waiter.finish(result);
		}
	}

	function markDirty(): void {
		dirty = true;
		if (running || isClosed()) return;
		running = true;
		void runLoop();
	}

	async function runLoop(): Promise<void> {
		try {
			while (dirty && !isClosed()) {
				dirty = false;
				await reconcileOnce();
			}
		} finally {
			running = false;
			if (dirty && !isClosed()) markDirty();
		}
	}

	function scheduleRetry(failures: number): void {
		if (isClosed() || retryTimer) return;
		const delay = Math.min(250 * 2 ** Math.max(0, failures - 1), 5_000);
		const entry: Scheduled = { cancel: () => {} };
		entry.cancel = clock.schedule(delay, () => {
			if (retryTimer !== entry || isClosed()) return;
			retryTimer = null;
			retryReady = true;
			markDirty();
		});
		retryTimer = entry;
	}

	function scheduleStable(epoch: number): void {
		if (stableTimer?.epoch === epoch) return;
		cancelStable();
		const entry = { epoch, scheduled: { cancel: () => {} } as Scheduled };
		entry.scheduled.cancel = clock.schedule(STABLE_MS, () => {
			if (stableTimer !== entry) return;
			stableTimer = null;
			if (
				link.phase !== "up" ||
				link.epoch !== epoch ||
				!link.powered ||
				link.discovery !== "on" ||
				failureCount === 0
			)
				return;
			failureCount = 0;
		});
		stableTimer = entry;
	}

	function removeClient(active: DbusClient, close: boolean): void {
		discardConnectingSignals(active);
		if (client !== active) return;
		client = null;
		const remove = removeClientListeners;
		removeClientListeners = null;
		remove?.();
		if (close) active.close();
	}

	function isBufferedConnectSignal(message: DbusMessage): boolean {
		return message.type === "signal" && (message.interface === OBJECT_MANAGER || message.interface === PROPERTIES);
	}

	function discardConnectingSignals(active: DbusClient): void {
		if (connectingClient !== active) return;
		connectingClient = null;
		connectingSignals = [];
	}

	function takeConnectingSignals(active: DbusClient): DbusMessage[] {
		if (connectingClient !== active) return [];
		const buffered = connectingSignals;
		connectingClient = null;
		connectingSignals = [];
		return buffered;
	}

	function attachClient(active: DbusClient): void {
		client = active;
		connectingClient = active;
		connectingSignals = [];
		const removeSignal = active.onSignal((message) => {
			if (client !== active) return;
			if (connectingClient === active && isBufferedConnectSignal(message)) {
				connectingSignals.push(message);
				return;
			}
			handleSignal(message);
		});
		const removeClose = active.onClose((error) => {
			if (client !== active || isClosed()) return;
			discardConnectingSignals(active);
			client = null;
			removeClientListeners?.();
			removeClientListeners = null;
			markDown();
			lastFailure = error ? (dbusErrorIsNoRadio(error) ? "no_radio" : "failed") : "no_radio";
			settleReady();
			markDirty();
		});
		removeClientListeners = () => {
			removeSignal();
			removeClose();
		};
	}

	function markDown(): void {
		if (link.phase === "closed") return;
		failureCount++;
		cancelStable();
		cancelRetry();
		link = { phase: "down", failures: failureCount };
		lastFailure = null;
	}

	function failureResult(error: unknown): DiscoveryReady {
		return dbusErrorIsNoRadio(error) ? "no_radio" : "failed";
	}

	function failedConnection(snapshot: Extract<Link, { phase: "down" }>, error: unknown, active?: DbusClient): void {
		if (link !== snapshot || isClosed()) {
			if (active) removeClient(active, true);
			return;
		}
		failureCount = snapshot.failures + 1;
		link = { phase: "down", failures: failureCount };
		lastFailure = failureResult(error);
		if (active) removeClient(active, true);
		settleReady();
		if (holds.size > 0) scheduleRetry(failureCount);
	}

	function failedOperation(
		snapshot: UpLink,
		error: unknown,
		unknownDiscovery: boolean,
		unknownFilter: boolean,
	): void {
		if (link !== snapshot || isClosed()) return;
		failureCount++;
		link = {
			...snapshot,
			discovery: unknownDiscovery ? "unknown" : snapshot.discovery,
			filter: unknownFilter ? null : snapshot.filter,
		};
		lastFailure = failureResult(error);
		settleReady();
		scheduleRetry(failureCount);
	}

	function call(
		active: DbusClient,
		method: string,
		path: string,
		iface: string,
		signature?: string,
		body?: DbusValue[],
	): Promise<DbusMessage> {
		return active.call({
			destination: BLUEZ_NAME,
			path,
			interface: iface,
			member: method,
			bodySignature: signature,
			body,
		});
	}

	function busCall(active: DbusClient, member: string, signature: string, body: DbusValue[]): Promise<DbusMessage> {
		return active.call({
			destination: DBUS_NAME,
			path: DBUS_PATH,
			interface: DBUS_NAME,
			member,
			bodySignature: signature,
			body,
		});
	}

	function devicesFrom(objects: Map<DbusValue, DbusValue>): Map<string, Map<string, DbusValue>> {
		const devices = new Map<string, Map<string, DbusValue>>();
		for (const [path, interfaces] of objects) {
			if (typeof path !== "string") continue;
			const device = mapOf(interfaces).get(DEVICE);
			if (device === undefined) continue;
			const props = new Map<string, DbusValue>();
			for (const [name, value] of mapOf(device)) if (typeof name === "string") props.set(name, value);
			rememberProperties(devices, path, props);
		}
		return devices;
	}

	async function connect(snapshot: Extract<Link, { phase: "down" }>): Promise<void> {
		let active: DbusClient | undefined;
		try {
			const previous = client;
			if (previous) removeClient(previous, true);
			active = clientFactory();
			attachClient(active);
			await active.connect();
			if (link !== snapshot || isClosed() || holds.size === 0) {
				removeClient(active, true);
				return;
			}
			for (const rule of MATCH_RULES) {
				await busCall(active, "AddMatch", "s", [rule]);
				if (link !== snapshot || isClosed() || holds.size === 0) {
					removeClient(active, true);
					return;
				}
			}
			const result = await call(active, "GetManagedObjects", "/", OBJECT_MANAGER);
			if (link !== snapshot || isClosed() || holds.size === 0) {
				removeClient(active, true);
				return;
			}
			const objects = mapOf(result.body?.[0]);
			let adapter: string | null = null;
			let powered = false;
			for (const [path, interfaces] of objects) {
				if (typeof path !== "string") continue;
				const properties = mapOf(interfaces).get(ADAPTER);
				if (properties === undefined || adapter !== null) continue;
				adapter = path;
				powered = unwrap(mapOf(properties).get("Powered")) === true;
			}
			if (!adapter) throw new BluezNoRadioError();
			link = {
				phase: "up",
				epoch: nextEpoch++,
				adapter,
				powered,
				devices: devicesFrom(objects),
				discovery: "off",
				filter: null,
			};
			lastFailure = null;
			for (const signal of takeConnectingSignals(active)) handleSignal(signal);
			settleReady();
			markDirty();
		} catch (error) {
			failedConnection(snapshot, error, active);
		}
	}

	function observationFor(path: string, props: Map<string, DbusValue>): BluezObservation | null {
		const mac = normalizeMac(unwrap(props.get("Address"))) ?? macForPath(path);
		const rawSignal = unwrap(props.get("RSSI"));
		if (!mac || typeof rawSignal !== "number" || !Number.isInteger(rawSignal) || rawSignal < -127 || rawSignal > 20)
			return null;
		const name = unwrap(props.get("Name")) ?? unwrap(props.get("Alias"));
		return {
			mac,
			signal: rawSignal,
			advert: {
				...(typeof name === "string" && name.length > 0 ? { name: name.slice(0, 64) } : {}),
				data: manufacturerEntries(props.get("ManufacturerData")),
				services: serviceIds(unwrap(props.get("UUIDs"))),
			},
			at: clock.now(),
		};
	}

	function observe(path: string, props: Map<string, DbusValue>): void {
		const observation = observationFor(path, props);
		if (!observation) return;
		for (const listener of observationListeners) {
			try {
				listener(observation);
			} catch {}
		}
	}

	function handleSignal(message: DbusMessage): void {
		if (message.type !== "signal") return;
		if (
			message.interface === DBUS_NAME &&
			message.member === "NameOwnerChanged" &&
			message.body?.[0] === BLUEZ_NAME
		) {
			markDown();
			markDirty();
			return;
		}
		if (link.phase !== "up") return;
		if (message.interface === OBJECT_MANAGER && message.member === "InterfacesAdded") {
			const path = message.body?.[0];
			if (typeof path !== "string") return;
			const device = mapOf(message.body?.[1]).get(DEVICE);
			if (device === undefined) return;
			const props = new Map<string, DbusValue>();
			for (const [name, value] of mapOf(device)) if (typeof name === "string") props.set(name, value);
			rememberProperties(link.devices, path, props);
			observe(path, props);
			return;
		}
		if (message.interface === OBJECT_MANAGER && message.member === "InterfacesRemoved") {
			const path = message.body?.[0];
			if (typeof path !== "string") return;
			const removed = Array.isArray(message.body?.[1]) ? message.body[1] : [];
			if (removed.some((iface) => iface === DEVICE)) link.devices.delete(path);
			if (path === link.adapter && removed.some((iface) => iface === ADAPTER)) {
				markDown();
				markDirty();
			}
			return;
		}
		if (message.interface !== PROPERTIES || message.member !== "PropertiesChanged") return;
		if (message.body?.[0] === ADAPTER && message.path === link.adapter) {
			const changed = mapOf(message.body[1]);
			if (!changed.has("Powered")) return;
			const powered = unwrap(changed.get("Powered")) === true;
			cancelRetry();
			link = { ...link, powered, discovery: "off", filter: null };
			lastFailure = null;
			settleReady();
			markDirty();
			return;
		}
		if (message.body?.[0] !== DEVICE || !message.path) return;
		let props = link.devices.get(message.path);
		if (!props) {
			props = new Map();
			const mac = macForPath(message.path);
			if (mac) props.set("Address", variant("s", mac));
			rememberProperties(link.devices, message.path, props);
		}
		for (const [name, value] of mapOf(message.body[1])) if (typeof name === "string") props.set(name, value);
		if (Array.isArray(message.body[2])) {
			for (const name of message.body[2]) if (typeof name === "string") props.delete(name);
		}
		observe(message.path, props);
	}

	async function reconcileOnce(): Promise<void> {
		const current = link;
		if (current.phase === "closed") return;
		if (current.phase === "down" && holds.size === 0) {
			cancelRetry();
			return;
		}
		if (current.phase === "up" && holds.size === 0 && current.discovery === "off") {
			cancelRetry();
			return;
		}
		if (retryTimer) return;
		const retryWasDue = retryReady;
		retryReady = false;
		if (current.phase === "down") {
			if (holds.size === 0) return;
			if (current.failures > 0 && !retryWasDue) {
				scheduleRetry(current.failures);
				return;
			}
			await connect(current);
			return;
		}
		if (!current.powered) return;
		if (holds.size === 0) {
			if (current.discovery === "off") return;
			const snapshot = current;
			const active = client;
			if (!active) {
				failureCount++;
				link = { ...snapshot, discovery: "unknown" };
				scheduleRetry(failureCount);
				return;
			}
			try {
				await call(active, "StopDiscovery", snapshot.adapter, ADAPTER);
				if (link !== snapshot || isClosed()) return;
				link = { ...snapshot, discovery: "off" };
				settleReady();
				markDirty();
			} catch (error) {
				if (link !== snapshot || isClosed()) return;
				if (dbusErrorIsNoDiscoveryStarted(error)) {
					link = { ...snapshot, discovery: "off" };
					markDirty();
					return;
				}
				failedOperation(snapshot, error, true, false);
			}
			return;
		}
		const desired = unionFilters(holds.values());
		const desiredKey = canonical(desired);
		if (current.filter !== desiredKey) {
			const snapshot = current;
			const active = client;
			if (!active) {
				failedOperation(snapshot, new DbusConnectionError(new Error("client unavailable")), false, true);
				return;
			}
			try {
				await call(active, "SetDiscoveryFilter", snapshot.adapter, ADAPTER, "a{sv}", [desired]);
				if (link !== snapshot || isClosed()) return;
				link = { ...snapshot, filter: desiredKey };
				markDirty();
			} catch (error) {
				failedOperation(snapshot, error, false, true);
			}
			return;
		}
		if (current.discovery === "on") {
			scheduleStable(current.epoch);
			return;
		}
		const snapshot = current;
		const active = client;
		if (!active) {
			failedOperation(snapshot, new DbusConnectionError(new Error("client unavailable")), true, false);
			return;
		}
		try {
			await call(active, "StartDiscovery", snapshot.adapter, ADAPTER);
			if (link !== snapshot || isClosed()) return;
			link = { ...snapshot, discovery: "on" };
			lastFailure = null;
			settleReady();
			scheduleStable(snapshot.epoch);
		} catch (error) {
			if (link !== snapshot || isClosed()) return;
			if (dbusErrorIsInProgress(error)) {
				link = { ...snapshot, discovery: "on" };
				lastFailure = null;
				settleReady();
				scheduleStable(snapshot.epoch);
				return;
			}
			failedOperation(snapshot, error, true, false);
		}
	}

	function hold(filter: DiscoveryFilter = {}): DiscoveryHold {
		const token = Symbol();
		let released = link.phase === "closed";
		if (!released) holds.set(token, copyFilter(filter));
		lastFailure = null;
		markDirty();
		settleReady();
		return {
			update: (next) => {
				if (released || !holds.has(token)) return;
				holds.set(token, copyFilter(next));
				lastFailure = null;
				markDirty();
				settleReady();
			},
			release: () => {
				if (released) return;
				released = true;
				holds.delete(token);
				settleReady();
				markDirty();
			},
			ready: (timeoutMs) => {
				const result = readiness(token);
				if (result) return Promise.resolve(result);
				if (timeoutMs <= 0) return Promise.resolve("failed");
				return new Promise((resolve) => {
					let done = false;
					let cancel = () => {};
					const waiter: ReadyWaiter = {
						token,
						finish: (answer) => {
							if (done) return;
							done = true;
							cancel();
							readyWaiters.delete(waiter);
							resolve(answer);
						},
					};
					readyWaiters.add(waiter);
					cancel = clock.schedule(timeoutMs, () => waiter.finish("failed"));
					settleReady();
				});
			},
		};
	}

	async function scan(windowMs = DEFAULT_SCAN_WINDOW_MS): Promise<HostBleScanResult> {
		const discovery = hold();
		const ready = await discovery.ready(SCAN_READY_TIMEOUT_MS);
		if (ready !== "discovering") {
			discovery.release();
			return HostBleScanResultSchema.parse({ reason: ready === "no_radio" ? "no_radio" : "scan_failed" });
		}
		const heard = new Map<string, HeardDevice>();
		const startedAt = clock.now();
		const onObservation = (observation: BluezObservation) => {
			if (observation.at >= startedAt) combineHeard(heard, observation);
		};
		observationListeners.add(onObservation);
		if (link.phase === "up") {
			for (const [path, properties] of link.devices) {
				const observation = observationFor(path, properties);
				if (observation) combineHeard(heard, observation);
			}
		}
		await new Promise<void>((resolve) =>
			clock.schedule(Math.min(MAX_SCAN_WINDOW_MS, Math.max(1, windowMs)), resolve),
		);
		discovery.release();
		observationListeners.delete(onObservation);
		const devices = [...heard.values()].map((device) => ({
			mac: device.mac,
			...(device.name ? { name: device.name } : {}),
			signal: device.signal,
			data: device.data,
			services: [...device.services],
		}));
		return HostBleScanResultSchema.parse({ devices });
	}

	function close(): void {
		if (isClosed()) return;
		link = { phase: "closed" };
		cancelRetry();
		cancelStable();
		settleReady();
		const active = client;
		if (active) removeClient(active, true);
		holds.clear();
		observationListeners.clear();
	}

	return {
		hold,
		onObservation: (listener) => {
			observationListeners.add(listener);
			return () => observationListeners.delete(listener);
		},
		scan,
		close,
	};
}

export function createBluetoothScanner(options: BluezCoordinatorOptions = {}): () => Promise<HostBleScanResult> {
	const coordinator = createBluezCoordinator(options);
	return () => coordinator.scan();
}
