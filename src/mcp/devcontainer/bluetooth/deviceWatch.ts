import {
	DEVICE_ADVERTISEMENT_BATCH_MAX,
	type DeviceAdvertFrame,
	DeviceAdvertFrameSchema,
	type DeviceWatchEntry,
	DeviceWatchFrameSchema,
} from "../../../shared/schemasDeviceBluetooth.js";
import type { BluezCoordinator, BluezObservation, DiscoveryHold } from "./bluez.js";

const BATCH_DELAY_MS = 100;

export interface DeviceWatchController {
	replace(raw: unknown): boolean;
	discardPending(): void;
	close(): void;
}

export function createDeviceWatchController(
	coordinator: Pick<BluezCoordinator, "hold" | "onObservation">,
	send: (frame: DeviceAdvertFrame) => void,
): DeviceWatchController {
	let watch = new Map<string, DeviceWatchEntry>();
	let hold: DiscoveryHold | null = null;
	let removeObservation: (() => void) | null = null;
	let batchTimer: ReturnType<typeof setTimeout> | null = null;
	let pending: BluezObservation[] = [];
	let closed = false;

	const flush = (): void => {
		if (batchTimer) clearTimeout(batchTimer);
		batchTimer = null;
		if (pending.length === 0) return;
		const observations = pending.map(({ mac, advert, at }) => ({ mac, advert, at }));
		pending = [];
		const frame = DeviceAdvertFrameSchema.safeParse({ type: "device_advert", observations });
		if (frame.success) send(frame.data);
	};

	const discardPending = (): void => {
		if (batchTimer) clearTimeout(batchTimer);
		batchTimer = null;
		pending = [];
	};

	const observe = (observation: BluezObservation): void => {
		if (closed || !watch.has(observation.mac)) return;
		if (pending.length >= DEVICE_ADVERTISEMENT_BATCH_MAX) flush();
		pending.push(observation);
		if (!batchTimer) batchTimer = setTimeout(flush, BATCH_DELAY_MS);
	};

	const filterOf = (): Record<string, { signature: string; value: boolean }> =>
		[...watch.values()].some((entry) => entry.activeScan) ? { DuplicateData: { signature: "b", value: true } } : {};

	const clearWatch = (): void => {
		removeObservation?.();
		removeObservation = null;
		discardPending();
		hold?.release();
		hold = null;
	};

	return {
		replace: (raw) => {
			const parsed = DeviceWatchFrameSchema.safeParse(raw);
			if (!parsed.success || closed) return false;
			watch = new Map(parsed.data.watch.map((entry) => [entry.mac, entry]));
			if (watch.size === 0) {
				clearWatch();
				return true;
			}
			if (!hold) {
				hold = coordinator.hold(filterOf());
				removeObservation = coordinator.onObservation(observe);
			} else hold.update(filterOf());
			return true;
		},
		discardPending,
		close: () => {
			if (closed) return;
			closed = true;
			watch.clear();
			clearWatch();
		},
	};
}
