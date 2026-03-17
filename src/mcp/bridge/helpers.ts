import WebSocket from "ws";
import type { EffortEnv, InjectPayload } from "../../shared/types.js";
import { AGENT_HANDLERS } from "../agent-handlers.js";
import { buildFollowUpPrompt, buildInitialPrompt } from "../prompt-builders.js";
import { resolveModel } from "../resolve-model.js";

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

// Bridge state — set by initBridge(), read by tool handlers after MCP connects
let ROUTER_URL = "";
let PROJECT_NAME = "";
let AGENT_TYPE = "";
let EFFORT_ENV: EffortEnv = { simple: "auto", standard: "auto", complex: "auto" };

let routerWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 2000;
const RECONNECT_MAX_MS = 30000;

export function initBridge(config: BridgeConfig): void {
	ROUTER_URL = config.routerUrl;
	PROJECT_NAME = config.projectName;
	AGENT_TYPE = config.agentType;
	EFFORT_ENV = config.effortEnv;
}

export function bridgeProjectName(): string {
	return PROJECT_NAME;
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

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connectToRouter();
	}, reconnectDelay);
	console.error(`[bridge] reconnecting in ${reconnectDelay / 1000}s...`);
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

export function connectToRouter(): void {
	const wsUrl = ROUTER_URL.replace(/^http/, "ws");
	routerWs = new WebSocket(wsUrl);

	routerWs.on("open", () => {
		console.error(`[bridge] connected to router`);
		reconnectDelay = 2000;
		const registerMsg: Record<string, string> = { type: "register", team: PROJECT_NAME };
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
		if (msg.type === "inject") {
			handleInject(msg as unknown as InjectPayload).catch((err: Error) => {
				console.error(`[bridge] handleInject error: ${err.message}`);
			});
		}
	});

	routerWs.on("close", () => {
		console.error(`[bridge] disconnected`);
		scheduleReconnect();
	});

	routerWs.on("error", (err: Error) => {
		console.error(`[bridge] ws error: ${err.message}`);
	});
}

export function closeRouter(): void {
	if (routerWs) routerWs.close();
}

// Inject handler — receives requests from other teams via the router

async function handleInject(msg: InjectPayload): Promise<void> {
	const sessionId = msg.session_id;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		console.error(`[bridge] inject missing session_id; router must send it`);
		return;
	}

	const handler = AGENT_HANDLERS[AGENT_TYPE];
	if (!handler) {
		console.error(`[bridge] unknown agent type: "${AGENT_TYPE}"`);
		await routerPost("/respond", {
			session_id: sessionId,
			status: "error",
			reason: `Agent type "${AGENT_TYPE}" is not a recognized handler. Valid types: ${Object.keys(AGENT_HANDLERS).join(", ")}`,
		}).catch(() => {});
		return;
	}

	try {
		const model = resolveModel(msg.effort, { effortEnv: EFFORT_ENV, agentType: AGENT_TYPE });
		const isFollowUp = !!msg.is_follow_up;
		const agentSessionId = isFollowUp ? sessionId : await handler.createSession(sessionId);

		const prompt = isFollowUp ? buildFollowUpPrompt(msg, sessionId) : buildInitialPrompt(msg, sessionId);

		console.error(
			`[bridge] ${isFollowUp ? "follow-up" : "new"} ${AGENT_TYPE}/${model} session ${sessionId.slice(0, 8)}... from ${msg.from}`,
		);

		await handler.sendMessage(agentSessionId, prompt, model, isFollowUp);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[bridge] inject failed: ${message}`);
		await routerPost("/respond", {
			session_id: sessionId,
			status: "error",
			reason: message,
		}).catch(() => {});
	}
}
