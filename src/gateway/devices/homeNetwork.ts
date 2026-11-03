import type { HostOp, HostOpResult } from "../../shared/host-op.js";
import { HostWifiNetworkResultSchema } from "../../shared/host-op.js";

export type WifiNetworkRelay = (op: Extract<HostOp, { kind: "wifiNetwork" }>) => Promise<HostOpResult>;

export type HomeNetworkAnswer =
	| { kind: "ok"; ssid: string | null }
	| { kind: "refused"; code: "daemon_away" | "timeout" };

/** The WiFi this Gateway's host is on, which a plug must join for the Gateway to reach it. */
export function createHomeNetwork(relayToHost: WifiNetworkRelay) {
	return async function homeNetwork(): Promise<HomeNetworkAnswer> {
		let relay: HostOpResult;
		try {
			relay = await relayToHost({ kind: "wifiNetwork" });
		} catch {
			return { kind: "refused", code: "daemon_away" };
		}
		if (!relay.ok) return { kind: "refused", code: relay.errorKind === "timeout" ? "timeout" : "daemon_away" };
		const result = HostWifiNetworkResultSchema.safeParse(relay.result);
		return { kind: "ok", ssid: result.success && "ssid" in result.data ? result.data.ssid : null };
	};
}
