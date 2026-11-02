import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { HostKasaScanResultSchema } from "../../shared/host-op.js";
import { ConsoleDeviceScanResultSchema } from "../../shared/schemasDevices.js";

export type KasaScanRelay = (op: Extract<HostOp, { kind: "kasaScan" }>) => Promise<HostOpResult>;

/** Relays the daemon's scan. */
export function createDeviceScan(relayToHost: KasaScanRelay) {
	return async function scanDevices() {
		let relay: HostOpResult;
		try {
			relay = await relayToHost({ kind: "kasaScan" });
		} catch {
			return ConsoleDeviceScanResultSchema.parse({ reason: "daemon_away" });
		}

		if (!relay.ok) {
			const reason = relay.errorKind === "timeout" ? "timeout" : "daemon_away";
			return ConsoleDeviceScanResultSchema.parse({ reason });
		}

		const result = HostKasaScanResultSchema.safeParse(relay.result);
		if (!result.success || "reason" in result.data) {
			return ConsoleDeviceScanResultSchema.parse({ reason: "refused" });
		}
		return ConsoleDeviceScanResultSchema.parse({ candidates: result.data.candidates });
	};
}
