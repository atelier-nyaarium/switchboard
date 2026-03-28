import crypto from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import WebSocket from "ws";
import { createReconnector } from "../../shared/reconnect.js";
import type {
	ChannelPushPayload,
	ConnectionMode,
	EffortEnv,
	InjectPayload,
	ResponsePushPayload,
} from "../../shared/types.js";
import { emitChannelNotification, emitResponseNotification } from "../channel/channelNotify.js";
import { handleInject } from "../cli/handleInject.js";

////////////////////////////////
//  Interfaces & Types

export interface BridgeConfig {
	routerUrl: string;
	projectName: string;
	agentType: string;
	effortEnv: EffortEnv;
}

interface RouterPostOptions {
	retries?: number;
	retryDelayMs?: number;
}

////////////////////////////////
//  Functions & Helpers

// Bridge state: set by initBridge(), read by tool handlers after MCP connects
let ROUTER_URL = "";
let PROJECT_NAME = "";
let AGENT_TYPE = "";
let EFFORT_ENV: EffortEnv = {};

const DEBUG_LOG = "/home/nyaarium/projects/agent-team-bridge/.cursor/debug.log";
const RUN_ID = `bridge-${process.pid}-${Date.now().toString(36)}`;

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown>): void {
	try {
		mkdirSync("/home/nyaarium/projects/agent-team-bridge/.cursor", { recursive: true });
		const line = JSON.stringify({
			runId: RUN_ID,
			hypothesisId,
			location,
			message,
			data,
			timestamp: new Date().toISOString(),
		});
		appendFileSync(DEBUG_LOG, `${line}\n`);
	} catch {
		// Silent
	}
}

let routerWs: WebSocket | null = null;
let previousSubId: string | null = null;
const reconnector = createReconnector(() => connectToRouter());

// Server instance for channel notifications (set when Claude + channel mode)
let channelServer: Server | null = null;

// Callback for dynamically registering evie tools when they arrive via WebSocket
let evieToolsHandler: ((tools: unknown[]) => void) | null = null;

export function initBridge(config: BridgeConfig): void {
	ROUTER_URL = config.routerUrl;
	PROJECT_NAME = config.projectName;
	AGENT_TYPE = config.agentType;
	EFFORT_ENV = config.effortEnv;
}

export function setChannelServer(server: Server): void {
	channelServer = server;
}

export function setEvieToolsHandler(handler: (tools: unknown[]) => void): void {
	evieToolsHandler = handler;
}

export function bridgeProjectName(): string {
	return PROJECT_NAME;
}

export function bridgeAgentType(): string {
	return AGENT_TYPE;
}

export async function routerPost(
	path: string,
	body: unknown,
	{ retries = 4, retryDelayMs = 1500 }: RouterPostOptions = {},
): Promise<unknown> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(`${ROUTER_URL}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return res.json();
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (attempt < retries) {
				const delay = retryDelayMs * 2 ** attempt;
				console.error(
					`[bridge] routerPost ${path} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${lastErr.message}`,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}
	throw lastErr;
}

export async function routerGet(
	path: string,
	{ retries = 2, retryDelayMs = 1000 }: RouterPostOptions = {},
): Promise<unknown> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(`${ROUTER_URL}${path}`);
			return res.json();
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			if (attempt < retries) {
				const delay = retryDelayMs * 2 ** attempt;
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}
	throw lastErr;
}

// WebSocket connection to router

export function connectToRouter(): void {
	const wsUrl = `${ROUTER_URL.replace(/^http/, "ws")}/bridge`;
	routerWs = new WebSocket(wsUrl);

	const isChannel = AGENT_TYPE === "claude";
	const mode: ConnectionMode = isChannel ? "channel" : "cli";

	routerWs.on("open", () => {
		console.error(`[bridge] connected to router (mode: ${mode})`);
		reconnector.reset();
		const subId = crypto.randomUUID().slice(0, 8);

		// #region Hypothesis F: track subId lifecycle across reconnects
		debugLog("F", "src/mcp/bridge/helpers.ts:connectToRouter", "registering new subId", {
			pid: process.pid,
			team: PROJECT_NAME,
			newSubId: subId,
			previousSubId: previousSubId ?? "none",
			mode,
		});
		previousSubId = subId;
		// #endregion

		const registerMsg: Record<string, string> = { type: "register", team: PROJECT_NAME, mode, subId };
		if (process.env.PROJECT_HOST_PATH) {
			registerMsg.projectPath = process.env.PROJECT_HOST_PATH;
		}
		routerWs!.send(JSON.stringify(registerMsg));
	});

	routerWs.on("message", (raw: WebSocket.Data) => {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		// Channel mode: receive channel_push messages for Claude
		if (msg.type === "channel_push" && isChannel && channelServer) {
			emitChannelNotification(channelServer, msg as unknown as ChannelPushPayload).catch((err: Error) => {
				console.error(`[channel] notification error: ${err.message}`);
			});
		}

		// Channel mode: receive response_push when a reply arrives for a sent request
		if (msg.type === "response_push" && isChannel && channelServer) {
			emitResponseNotification(channelServer, msg as unknown as ResponsePushPayload).catch((err: Error) => {
				console.error(`[channel] response notification error: ${err.message}`);
			});
		}

		// CLI mode: receive inject messages for non-Claude agents
		if (msg.type === "inject" && !isChannel) {
			handleInject(msg as unknown as InjectPayload, AGENT_TYPE, EFFORT_ENV).catch((err: Error) => {
				console.error(`[bridge] handleInject error: ${err.message}`);
			});
		}

		// Host mode: receive evie tool schemas pushed from arbiter
		if (msg.type === "evie_tools" && Array.isArray(msg.tools) && evieToolsHandler) {
			evieToolsHandler(msg.tools);
		}
	});

	routerWs.on("close", () => {
		// #region Hypothesis F: log disconnect with subId that arbiter should clean up
		debugLog("F", "src/mcp/bridge/helpers.ts:connectToRouter", "disconnected", {
			pid: process.pid,
			team: PROJECT_NAME,
			subId: previousSubId ?? "unknown",
		});
		// #endregion
		console.error(`[bridge] disconnected`);
		reconnector.schedule();
	});

	routerWs.on("error", (err: Error) => {
		// #region Hypothesis F: log connection error
		debugLog("F", "src/mcp/bridge/helpers.ts:connectToRouter", "ws error", {
			pid: process.pid,
			team: PROJECT_NAME,
			subId: previousSubId ?? "unknown",
			error: err.message,
		});
		// #endregion
		console.error(`[bridge] ws error: ${err.message}`);
	});
}

export function closeRouter(): void {
	if (routerWs) routerWs.close();
}
