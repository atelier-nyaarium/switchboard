// Runs in a session's pane: one OpenCode server, then its terminal UI.

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LauncherPorts, parseLaunchArgs, runLauncher } from "./opencode-launch/launcher.js";
import { startOpencodeServer } from "./opencode-launch/serverProcess.js";
import { writeFileAtomic } from "./shared/atomic-write.js";
import { launchGoing, readLaunchStatus } from "./shared/launch-status.js";
import { moduleDir, packageRoot } from "./shared/plugin-root.js";
import { installRejectionGuard } from "./shared/process-guards.js";
import { FIRST_LAUNCH_GREETING } from "./shared/session-harness.js";

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

const args = parseLaunchArgs(process.argv.slice(2));
if (!args) {
	console.error("usage: main-opencode-launch --session <id> --status <file> [--greet]");
	process.exit(2);
}

installRejectionGuard("opencode-launch");

const SIGNALED = 129;

const privateDirs: string[] = [];
const leave = (): void => {
	for (const dir of privateDirs) fs.rmSync(dir, { recursive: true, force: true });
	// A relaunch may already own it.
	const held = readLaunchStatus(readText(args.statusFile));
	if (held?.pid !== process.pid || !launchGoing(held)) return;
	try {
		writeFileAtomic(args.statusFile, JSON.stringify({ state: "exited", pid: process.pid, code: SIGNALED }), {
			mode: 0o600,
		});
	} catch {
		// Its pane is gone with it.
	}
};
// The server ends with this process's pipe.
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		leave();
		process.exit(SIGNALED);
	});
}

const ports: LauncherPorts = {
	pid: process.pid,
	env: process.env,
	home: os.homedir(),
	cwd: process.cwd(),
	runtime: process.execPath,
	root: packageRoot(moduleDir(import.meta.url)),
	greeting: FIRST_LAUNCH_GREETING,
	isExecutable: (file) => {
		try {
			fs.accessSync(file, fs.constants.X_OK);
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	},
	readVersion: (binary) =>
		new Promise((resolve) => {
			execFile(binary, ["--version"], { timeout: 15_000 }, (error, stdout) =>
				resolve(error ? undefined : stdout),
			);
		}),
	startServer: startOpencodeServer,
	runUi: (binary, uiArgs, env) =>
		new Promise((resolve) => {
			const child = spawn(binary, uiArgs, { env, stdio: "inherit" });
			child.once("exit", (code) => resolve(code ?? 1));
			child.once("error", () => resolve(1));
		}),
	fetch,
	randomPassword: () => crypto.randomBytes(24).toString("hex"),
	makePrivateDir: () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-opencode-"));
		privateDirs.push(dir);
		return dir;
	},
	writePrivateFile: (file, text) => writeFileAtomic(file, text, { mode: 0o600 }),
	readFile: readText,
	remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
	log: (line) => console.error(line),
};

process.exit(await runLauncher(args, ports));
