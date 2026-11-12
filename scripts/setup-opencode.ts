// Setup's OpenCode step: this machine's installed version against the pin, and the install.

import os from "node:os";
import path from "node:path";
import { $ } from "bun";
import { HARNESS, OPENCODE_INSTALL_CMD, OPENCODE_PIN } from "../src/shared/session-harness.js";
import { note } from "./lib/host.js";
import { versionIn } from "./lib/opencodeVersion.js";

////////////////////////////////
//  Functions & Helpers

/** Where the daemon looks: the path, then the row's own folder under the home. */
function candidates(): string[] {
	const { posix, homeDir } = HARNESS.opencode.binary;
	return homeDir ? [posix, path.join(os.homedir(), homeDir, posix)] : [posix];
}

/** Undefined when no OpenCode answers. */
export async function installedOpencode(): Promise<string | undefined> {
	for (const binary of candidates()) {
		const answer = await $`${binary} --version`.nothrow().quiet();
		const version = answer.exitCode === 0 ? versionIn(answer.stdout.toString()) : undefined;
		if (version) return version;
	}
	return undefined;
}

export async function installOpencode(): Promise<void> {
	note(`Installing OpenCode ${OPENCODE_PIN}`);
	const run = await $`bash -c ${OPENCODE_INSTALL_CMD}`.nothrow();
	if (run.exitCode !== 0) throw new Error(`the OpenCode installer exited with ${run.exitCode}`);
	const installed = await installedOpencode();
	if (installed !== OPENCODE_PIN) {
		throw new Error(`OpenCode reads ${installed ?? "nothing"} after the install, not ${OPENCODE_PIN}`);
	}
	note(`OpenCode ${OPENCODE_PIN} is installed. Restart the host daemon to offer it: ./start-host-daemon.sh`);
}
