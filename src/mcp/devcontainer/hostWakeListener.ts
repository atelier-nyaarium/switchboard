import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { ensureContainerUpAsync, resolveProject } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

const HOME = os.homedir();
const RECONNECT_MAX_MS = 30000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 2000;
let arbiterUrl = "ws://localhost:20000";

export function startHostWakeListener(): void {
	const envUrl = process.env.BRIDGE_ROUTER_URL;
	if (envUrl) {
		arbiterUrl = envUrl.replace(/^http/, "ws");
	}
	connect();
}

export function stopHostWakeListener(): void {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
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
		reconnectDelay = 2000;
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
		scheduleReconnect();
	});

	ws.on("error", (err: Error) => {
		console.error(`[host-wake] ws error: ${err.message}`);
	});
}

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
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
		console.error(`[host-wake] starting ${msg.team} at ${resolved}`);
		await ensureContainerUpAsync(resolved);
		console.error(`[host-wake] ${msg.team} is up`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[host-wake] failed to wake ${msg.team}: ${message}`);
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "wake_result", team: msg.team, success: false, error: message }));
		}
	}
}
