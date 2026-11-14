import type { z } from "zod";
import { familyOf } from "../../shared/ble-recognition.js";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { HostBleScanResultSchema, HostKasaScanResultSchema } from "../../shared/host-op.js";
import {
	DEVICE_MAX_RECORDS,
	type DeviceCandidateSchema,
	type DeviceNearbySchema,
} from "../../shared/schemasDevices.js";

export type KasaScanRelay = (op: Extract<HostOp, { kind: "kasaScan" | "bleScan" }>) => Promise<HostOpResult>;

export type DeviceScanAnswer =
	| {
			kind: "ok";
			candidates: z.infer<typeof DeviceCandidateSchema>[];
			nearby?: z.infer<typeof DeviceNearbySchema>[];
			bluetooth?: boolean;
	  }
	| { kind: "refused"; code: "daemon_away" | "timeout" | "scan_failed" };

/** Caches host radio status. */
export function createDeviceScan(relayToHost: KasaScanRelay) {
	let radio: boolean | undefined;
	const scanDevices = async (): Promise<DeviceScanAnswer> => {
		const [kasaRelay, bleRelay] = await Promise.all([
			relayToHost({ kind: "kasaScan" }).catch(() => null),
			relayToHost({ kind: "bleScan" }).catch(() => null),
		]);

		const nearby = bleRelay?.ok ? HostBleScanResultSchema.safeParse(bleRelay.result) : null;
		const devices = nearby?.success && "devices" in nearby.data ? nearby.data.devices : null;
		if (devices) radio = true;
		else if (nearby?.success && "reason" in nearby.data && nearby.data.reason === "no_radio") radio = false;
		// Catalogued families, strongest first.
		const heard = devices
			?.filter((device) => familyOf(device) !== null)
			.sort((a, b) => b.signal - a.signal)
			.slice(0, DEVICE_MAX_RECORDS)
			.map((device) => ({ ...device, radio: "gateway" as const }));
		const kasa = kasaRelay?.ok ? HostKasaScanResultSchema.safeParse(kasaRelay.result) : null;
		const candidates = kasa?.success && !("reason" in kasa.data) ? kasa.data.candidates : null;
		if (!candidates && !heard) {
			if (!kasaRelay) return { kind: "refused", code: "daemon_away" };
			if (!kasaRelay.ok)
				return { kind: "refused", code: kasaRelay.errorKind === "timeout" ? "timeout" : "daemon_away" };
			return { kind: "refused", code: "scan_failed" };
		}
		return {
			kind: "ok",
			candidates: candidates ?? [],
			...(heard ? { nearby: heard } : {}),
			...(radio === undefined ? {} : { bluetooth: radio }),
		};
	};
	/** Unknown before first scan. */
	return Object.assign(scanDevices, { bluetooth: (): boolean | undefined => radio });
}
