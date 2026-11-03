// The WiFi network the host is on, from the first tool that can tell.

import { execFile } from "node:child_process";
import { type HostWifiNetworkResult, HostWifiNetworkResultSchema } from "../../shared/host-op.js";

const READ_TIMEOUT_MS = 3_000;

type Run = (file: string, args: readonly string[]) => Promise<string | null>;

/** `yes:<ssid>` from `nmcli -t -f ACTIVE,SSID dev wifi`; colons in a name come escaped. */
export function ssidFromNmcli(output: string): string | null {
	for (const line of output.split("\n")) {
		if (!line.startsWith("yes:")) continue;
		const ssid = line.slice(4).replace(/\\:/g, ":").trim();
		if (ssid) return ssid;
	}
	return null;
}

/** `iwgetid -r` prints the name alone. */
export function ssidFromIwgetid(output: string): string | null {
	return output.trim() || null;
}

/** The `SSID : <name>` line of `netsh wlan show interfaces`, never the BSSID one. */
export function ssidFromNetsh(output: string): string | null {
	const match = output.match(/^\s*SSID\s*:\s*(.+?)\s*$/m);
	return match?.[1] ? match[1] : null;
}

const READERS: readonly { file: string; args: readonly string[]; parse: (output: string) => string | null }[] = [
	{ file: "nmcli", args: ["-t", "-f", "ACTIVE,SSID", "dev", "wifi"], parse: ssidFromNmcli },
	{ file: "iwgetid", args: ["-r"], parse: ssidFromIwgetid },
	{ file: "netsh.exe", args: ["wlan", "show", "interfaces"], parse: ssidFromNetsh },
];

const runFile: Run = (file, args) =>
	new Promise((resolve) => {
		execFile(file, [...args], { timeout: READ_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			resolve(error ? null : String(stdout));
		});
	});

/** No input; the answer is the host's own network or `none`. */
export function createWifiNetworkReader(run: Run = runFile): () => Promise<HostWifiNetworkResult> {
	return async () => {
		for (const reader of READERS) {
			const output = await run(reader.file, reader.args);
			const ssid = output === null ? null : reader.parse(output);
			const parsed = ssid === null ? null : HostWifiNetworkResultSchema.safeParse({ ssid });
			if (parsed?.success) return parsed.data;
		}
		return { reason: "none" };
	};
}
