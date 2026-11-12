// Runs beside an OpenCode server: stdin and stdout are the bridge's protocol.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { type BridgePorts, startBridge } from "./opencode-agent/bridge.js";
import { startOpencodeServer } from "./opencode-launch/serverProcess.js";
import { installRejectionGuard } from "./shared/process-guards.js";

installRejectionGuard("opencode-agent");

const ports: BridgePorts = {
	env: process.env,
	home: os.homedir(),
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
	fetch,
	abortAfter: (ms) => AbortSignal.timeout(ms),
	randomHex: (bytes) => crypto.randomBytes(bytes).toString("hex"),
	sleep: (ms) =>
		new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			timer.unref?.();
		}),
	// Stdout is the protocol: nothing else may write to it.
	write: (line) => process.stdout.write(`${line}\n`),
	log: (line) => console.error(line),
};

const bridge = await startBridge(ports);
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	for (;;) {
		const cut = buffer.indexOf("\n");
		if (cut < 0) break;
		const line = buffer.slice(0, cut).trim();
		buffer = buffer.slice(cut + 1);
		if (line) bridge.receive(line);
	}
});
// The server ends with this process's pipe.
process.stdin.on("end", () => bridge.closed());
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(signal, () => bridge.closed());
await bridge.done;
process.exit(0);
