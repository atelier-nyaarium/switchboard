import { describe, expect, it } from "vitest";
import { createHomeNetwork } from "../gateway/devices/homeNetwork.js";
import {
	createWifiNetworkReader,
	ssidFromIwgetid,
	ssidFromNetsh,
	ssidFromNmcli,
} from "../mcp/devcontainer/wifiNetwork.js";

describe("the host's WiFi network", () => {
	it("reads the active network from each tool's output", () => {
		expect(ssidFromNmcli("no:Neighbor\nyes:Home\\:Net\nno:Other\n")).toBe("Home:Net");
		expect(ssidFromNmcli("no:Neighbor\n")).toBeNull();
		expect(ssidFromIwgetid("Home\n")).toBe("Home");
		expect(ssidFromIwgetid("\n")).toBeNull();
		const netsh =
			"    Name                   : Wi-Fi\n    SSID                   : Home Net\n    BSSID                  : 02:00:00:00:00:01\n";
		expect(ssidFromNetsh(netsh)).toBe("Home Net");
		expect(ssidFromNetsh("    State : disconnected\n")).toBeNull();
	});

	it("falls through the tools in order and answers none when no tool can tell", async () => {
		const asked: string[] = [];
		const missingNmcli = createWifiNetworkReader(async (file) => {
			asked.push(file);
			return file === "iwgetid" ? "Home\n" : null;
		});
		const nothing = createWifiNetworkReader(async () => null);

		expect(await missingNmcli()).toEqual({ ssid: "Home" });
		expect(asked).toEqual(["nmcli", "iwgetid"]);
		expect(await nothing()).toEqual({ reason: "none" });
	});

	it("relays the daemon's answer, a host on no WiFi as null, and a daemon that is down as a refusal", async () => {
		const on = createHomeNetwork(async () => ({ ok: true, result: { ssid: "Home" } }));
		const off = createHomeNetwork(async () => ({ ok: true, result: { reason: "none" } }));
		const late = createHomeNetwork(async () => ({ ok: false, errorKind: "timeout", error: "late" }));
		const down = createHomeNetwork(async () => {
			throw new Error("no daemon");
		});

		expect(await on()).toEqual({ kind: "ok", ssid: "Home" });
		expect(await off()).toEqual({ kind: "ok", ssid: null });
		expect(await late()).toEqual({ kind: "refused", code: "timeout" });
		expect(await down()).toEqual({ kind: "refused", code: "daemon_away" });
	});
});
