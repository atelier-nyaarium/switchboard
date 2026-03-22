import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createReconnector } from "../../shared/reconnect.js";
import { ensureContainerUpAsync, execInContainer, resolveProject } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

const HOME = os.homedir();

let ws: WebSocket | null = null;
let arbiterUrl = "ws://localhost:20000";
const reconnector = createReconnector(() => connect());

export function startHostWakeListener(): void {
	const envUrl = process.env.BRIDGE_ROUTER_URL;
	if (envUrl) {
		arbiterUrl = envUrl.replace(/^http/, "ws");
	}
	connect();
}

export function stopHostWakeListener(): void {
	if (ws) {
		ws.removeAllListeners();
		ws.close();
		ws = null;
	}
}

function connect(): void {
	ws = new WebSocket(`${arbiterUrl}/bridge`);

	ws.on("open", () => {
		console.error("[host-wake] connected to arbiter");
		reconnector.reset();
		ws!.send(JSON.stringify({ type: "register", team: "__host__" }));

		const projects = scanDevcontainerProjects();
		ws!.send(JSON.stringify({ type: "catalog", projects }));
		console.error(`[host-wake] sent catalog with ${projects.length} projects`);
	});

	ws.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.type === "wake") {
			handleWake(msg as unknown as WakeMessage);
		}
	});

	ws.on("close", () => {
		console.error("[host-wake] disconnected");
		reconnector.schedule();
	});

	ws.on("error", (err: Error) => {
		console.error(`[host-wake] ws error: ${err.message}`);
	});
}

////////////////////////////////
//  Catalog scanner

function scanDevcontainerProjects(): Array<{ team: string; projectPath: string }> {
	const results: Array<{ team: string; projectPath: string }> = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(HOME);
	} catch {
		return results;
	}
	for (const entry of entries) {
		const full = path.join(HOME, entry);
		try {
			if (!fs.statSync(full).isDirectory()) continue;
			if (fs.existsSync(path.join(full, ".devcontainer", "devcontainer.json"))) {
				results.push({ team: entry, projectPath: full });
			}
		} catch {
			// skip inaccessible entries
		}
	}
	return results;
}

////////////////////////////////
//  Wake handler

interface WakeMessage {
	type: "wake";
	team: string;
	projectPath?: string;
}

async function handleWake(msg: WakeMessage): Promise<void> {
	const projectPath = msg.projectPath || path.join(HOME, msg.team);

	try {
		const resolved = resolveProject(projectPath);
		const projectName = path.basename(resolved);
		console.error(`[host-wake] starting ${msg.team} at ${resolved}`);
		await ensureContainerUpAsync(resolved);
		console.error(`[host-wake] ${msg.team} container is up, starting Claude`);

		// Check if a "claude" tmux session already exists
		let sessionExists = false;
		try {
			await execInContainer({
				projectPath: resolved,
				command: ["tmux", "has-session", "-t", "claude"],
				timeoutMs: 10000,
			});
			sessionExists = true;
		} catch {
			// has-session exits non-zero if session doesn't exist
		}

		if (!sessionExists) {
			await execInContainer({
				projectPath: resolved,
				command: [
					"tmux",
					"new-session",
					"-d",
					"-s",
					"claude",
					`source ~/.bashrc && cd /workspace/${projectName} && claude-skip`,
				],
				timeoutMs: 15000,
			});
			console.error(`[host-wake] ${msg.team} Claude session started`);
		} else {
			console.error(`[host-wake] ${msg.team} Claude session already exists`);
		}

		// Poll tmux screen to auto-accept the dev channels prompt
		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			let screen = "";
			try {
				screen = await execInContainer({
					projectPath: resolved,
					command: ["tmux", "capture-pane", "-t", "claude", "-p"],
					timeoutMs: 10000,
				});
			} catch {
				// ignore capture errors
			}
			if (screen.includes("Claude Code")) {
				console.error(`[host-wake] ${msg.team} Claude is ready`);
				break;
			}
			if (screen.includes("Loading development channels")) {
				try {
					await execInContainer({
						projectPath: resolved,
						command: ["tmux", "send-keys", "-t", "claude", "", "Enter"],
						timeoutMs: 5000,
					});
				} catch {
					// ignore send-keys errors
				}
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[host-wake] failed to wake ${msg.team}: ${message}`);
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "wake_result", team: msg.team, success: false, error: message }));
		}
	}
}
