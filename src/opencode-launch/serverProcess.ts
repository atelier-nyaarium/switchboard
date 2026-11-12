// One `opencode serve` child, for the session launcher and the agent bridge.

import { spawn } from "node:child_process";
import type { ServerHandle } from "./launcher.js";

const STOP_GRACE_MS = 3000;
const ERROR_TAIL_CHARS = 1500;
const ANNOUNCE_MAX_CHARS = 65_536;

/** `--stdio` ties the server to its stdin and prints its URL as a JSON line. */
export function startOpencodeServer(binary: string, env: Record<string, string>): ServerHandle {
	const child = spawn(binary, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
		env,
		// Piped, never inherited: its lines would draw over a pane or corrupt a protocol.
		stdio: ["pipe", "pipe", "pipe"],
	});
	let errors = "";
	child.stderr.on("data", (chunk: Buffer) => {
		errors = (errors + chunk.toString("utf8")).slice(-ERROR_TAIL_CHARS);
	});
	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
	let buffer = "";
	const url = new Promise<string | undefined>((resolve) => {
		child.stdout.on("data", (chunk: Buffer) => {
			// Drained for its whole life.
			if (buffer.length > ANNOUNCE_MAX_CHARS) return;
			buffer += chunk.toString("utf8");
			for (const line of buffer.split("\n")) {
				try {
					const announced = (JSON.parse(line) as { url?: unknown }).url;
					if (typeof announced === "string") resolve(announced);
				} catch {
					// Not the announcement.
				}
			}
		});
		void exited.then(() => resolve(undefined));
	});
	return {
		url,
		exited,
		errorTail: () => errors,
		stop: () => {
			child.stdin.end();
			// A server that ignores both would outlive its owner.
			const term = setTimeout(() => child.kill("SIGTERM"), STOP_GRACE_MS);
			const kill = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS * 2);
			void exited.then(() => {
				clearTimeout(term);
				clearTimeout(kill);
			});
		},
	};
}
