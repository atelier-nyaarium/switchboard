import type { z } from "zod";
import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { HostKasaScanResultSchema } from "../../shared/host-op.js";
import type { DeviceCandidateSchema } from "../../shared/schemasDevices.js";

export type KasaScanRelay = (op: Extract<HostOp, { kind: "kasaScan" }>) => Promise<HostOpResult>;

export type DeviceScanAnswer =
	| { kind: "ok"; candidates: z.infer<typeof DeviceCandidateSchema>[] }
	| { kind: "refused"; code: "daemon_away" | "timeout" | "scan_failed" };

/** Relays the daemon's scan. */
export function createDeviceScan(relayToHost: KasaScanRelay) {
	return async function scanDevices(): Promise<DeviceScanAnswer> {
		let relay: HostOpResult;
		try {
			relay = await relayToHost({ kind: "kasaScan" });
		} catch {
			return { kind: "refused", code: "daemon_away" };
		}

		if (!relay.ok) return { kind: "refused", code: relay.errorKind === "timeout" ? "timeout" : "daemon_away" };

		const result = HostKasaScanResultSchema.safeParse(relay.result);
		if (!result.success || "reason" in result.data) return { kind: "refused", code: "scan_failed" };
		return { kind: "ok", candidates: result.data.candidates };
	};
}
