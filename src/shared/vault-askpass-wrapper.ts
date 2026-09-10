// The wrapper the daemon or the plugin writes.

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { VAULT_ASKPASS_HOME_PATH } from "./host-spawn.js";

export const ASKPASS_BUNDLE = "main-vault-askpass.js";

export interface AskpassWrapper {
	bun: string;
	bundle: string;
	/** Baked in when given. */
	gatewayUrl?: string;
}

const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function vaultAskpassBin(home: string): string {
	return path.join(home, VAULT_ASKPASS_HOME_PATH);
}

export function askpassWrapperText(wrapper: AskpassWrapper): string {
	const gateway = wrapper.gatewayUrl ? [`export BRIDGE_ROUTER_URL=${quoted(wrapper.gatewayUrl)}`] : [];
	return ["#!/usr/bin/env bash", ...gateway, `exec ${quoted(wrapper.bun)} ${quoted(wrapper.bundle)} "$@"`, ""].join(
		"\n",
	);
}

/** The text is the receipt `removeAskpassWrapper` asks for. */
export function installAskpassWrapper(home: string, wrapper: AskpassWrapper): { bin: string; text: string } {
	const bin = vaultAskpassBin(home);
	const text = askpassWrapperText(wrapper);
	if (readWrapper(bin) !== text) writeFileAtomic(bin, text, { mode: 0o755 });
	return { bin, text };
}

/** Only the file the receipt describes. */
export function removeAskpassWrapper(home: string, receipt: string): boolean {
	const bin = vaultAskpassBin(home);
	if (readWrapper(bin) !== receipt) return false;
	rmSync(bin, { force: true });
	return true;
}

function readWrapper(bin: string): string | null {
	try {
		return existsSync(bin) ? readFileSync(bin, "utf8") : null;
	} catch {
		return null;
	}
}
