import crypto from "node:crypto";
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

let routerWs: WebSocket | null = null;
const reconnector = createReconnector(() => connectToRouter());

// Server instance for channel notifications (set when Claude + channel mode)
let channelServer: Server | null = null;

export function initBridge(config: BridgeConfig): void {
	ROUTER_URL = config.routerUrl;
	PROJECT_NAME = config.projectName;
	AGENT_TYPE = config.agentType;
	EFFORT_ENV = config.effortEnv;
}

export function setChannelServer(server: Server): void {
	channelServer = server;
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

export async function routerGet(path: string): Promise<unknown> {
	const res = await fetch(`${ROUTER_URL}${path}`);
	return res.json();
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
	});

	routerWs.on("close", () => {
		console.error(`[bridge] disconnected`);
		reconnector.schedule();
	});

	routerWs.on("error", (err: Error) => {
		console.error(`[bridge] ws error: ${err.message}`);
	});
}

export function closeRouter(): void {
	if (routerWs) routerWs.close();
}
