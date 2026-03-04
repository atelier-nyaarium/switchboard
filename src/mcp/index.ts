import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { z } from "zod";

import { AGENT_HANDLERS } from "./agent-handlers.js";
import { buildFollowUpPrompt, buildInitialPrompt } from "./prompt-builders.js";
import { createReplyProxy } from "./reply-proxy.js";
import { resolveModel } from "./resolve-model.js";

import type { InjectPayload, ResponsePayload } from "../shared/types.js";

let ROUTER_URL: string;
let TEAM_NAME: string;
let AGENT_TYPE: string;
let EFFORT_ENV: { simple: string; standard: string; complex: string };

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function routerPost(path: string, body: unknown, { retries = 4, retryDelayMs = 1500 } = {}): Promise<unknown> {
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(`${ROUTER_URL}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return res.json();
		} catch (err: any) {
			lastErr = err;
			if (attempt < retries) {
				const delay = retryDelayMs * Math.pow(2, attempt);
				console.error(
					`[bridge-mcp] routerPost ${path} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms: ${err.message}`,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}
	throw lastErr;
}

async function routerGet(path: string): Promise<any> {
	const res = await fetch(`${ROUTER_URL}${path}`);
	return res.json();
}

// ---------------------------------------------------------------------------
// handleInject
// ---------------------------------------------------------------------------
async function handleInject(msg: InjectPayload) {
	const sessionId = msg.session_id;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		console.error("[bridge-mcp] inject missing session_id; router must send it");
		return;
	}

	const handler = AGENT_HANDLERS[AGENT_TYPE];
	if (!handler) {
		console.error(`[bridge-mcp] unknown agent type: "${AGENT_TYPE}"`);
		await routerPost("/respond", {
			session_id: sessionId,
			status: "error",
			reason: `Agent type "${AGENT_TYPE}" is not a recognized handler. Valid types: ${Object.keys(AGENT_HANDLERS).join(", ")}`,
		}).catch(() => {});
		return;
	}

	let replyProxy: { port: number; close: () => void } | undefined;
	try {
		replyProxy = await createReplyProxy(sessionId, routerPost);
	} catch (err: any) {
		await routerPost("/respond", {
			session_id: sessionId,
			status: "error",
			reason: err.message,
		}).catch(() => {});
		return;
	}

	try {
		const model = resolveModel(msg.effort, { effortEnv: EFFORT_ENV, agentType: AGENT_TYPE });
		const isFollowUp = !!msg.is_follow_up;
		const agentSessionId = isFollowUp ? sessionId : await handler.createSession(sessionId);

		const prompt = isFollowUp
			? buildFollowUpPrompt(msg, replyProxy.port, sessionId)
			: buildInitialPrompt(msg, replyProxy.port, sessionId);

		console.error(
			`[bridge-mcp] ${isFollowUp ? "follow-up" : "new"} ${AGENT_TYPE}/${model} session ${sessionId.slice(0, 8)}... from ${msg.from}`,
		);

		await handler.sendMessage(agentSessionId, prompt, model, isFollowUp);
	} catch (err: any) {
		console.error(`[bridge-mcp] inject failed: ${err.message}`);
		await routerPost("/respond", {
			session_id: sessionId,
			status: "error",
			reason: err.message,
		}).catch(() => {});
	} finally {
		if (replyProxy) replyProxy.close();
	}
}

// ---------------------------------------------------------------------------
// WebSocket connection to router
// ---------------------------------------------------------------------------
let routerWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 2000;
const RECONNECT_MAX_MS = 30000;

function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connectToRouter();
	}, reconnectDelay);
	console.error(`[bridge-mcp] reconnecting in ${reconnectDelay / 1000}s...`);
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function connectToRouter() {
	const wsUrl = ROUTER_URL.replace(/^http/, "ws");
	routerWs = new WebSocket(wsUrl);

	routerWs.on("open", () => {
		console.error(`[bridge-mcp] connected to router`);
		reconnectDelay = 2000;
		routerWs!.send(JSON.stringify({ type: "register", team: TEAM_NAME }));
	});

	routerWs.on("message", (raw: WebSocket.Data) => {
		let msg: any;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (msg.type === "inject") {
			handleInject(msg).catch((err: Error) => {
				console.error(`[bridge-mcp] handleInject error: ${err.message}`);
			});
		}
	});

	routerWs.on("close", () => {
		console.error(`[bridge-mcp] disconnected`);
		scheduleReconnect();
	});

	routerWs.on("error", (err: Error) => {
		console.error(`[bridge-mcp] ws error: ${err.message}`);
	});
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------
const mcpServer = new McpServer({
	name: "agent-team-bridge",
	version: "0.4.0",
});

mcpServer.tool("bridge_discover", "List all active teams on the bridge network.", {}, async () => {
	try {
		const teams = await routerGet("/teams");
		const others = teams.filter((t: any) => t.team !== TEAM_NAME);

		if (others.length === 0) {
			return { content: [{ type: "text" as const, text: "No other teams are currently online." }] };
		}

		const lines = others.map((t: any) => {
			const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "available";
			return `- ${t.team}: ${status}`;
		});

		return { content: [{ type: "text" as const, text: `Teams on the bridge:\n${lines.join("\n")}` }] };
	} catch (err: any) {
		return { content: [{ type: "text" as const, text: `Failed to reach router: ${err.message}` }], isError: true };
	}
});

mcpServer.tool(
	"bridge_send",
	"Send a request to another team and wait for their response. Blocks until they respond.",
	{
		to: z.string().describe("Target team name. You can use bridge_discover to find the available teams."),
		type: z.enum(["feature", "bugfix", "question"]).describe("The type of request you are making."),
		effort: z
			.enum(["simple", "standard", "complex"])
			.describe("How much effort it should take to understand and handle this request."),
		body: z
			.string()
			.describe(
				"Full Markdown formatted details of the request. Provide a detailed description of the request and any context that would be helpful to the other team.",
			),
		session_id: z
			.string()
			.optional()
			.describe(
				"Conversation session ID. Must be provided to continue the same conversation thread. Omit to start a new conversation thread.",
			),
	},
	async ({ to, type, effort, body, session_id }) => {
		try {
			const result = (await routerPost("/send", {
				from: TEAM_NAME,
				to,
				type,
				effort,
				body,
				session_id: session_id || null,
			})) as any;

			if (result.error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Bridge error: ${result.error}${result.available ? `\nAvailable: ${result.available.join(", ")}` : ""}`,
						},
					],
					isError: true,
				};
			}

			const parts = [`Response from ${to}:`, `Status: ${result.status}`];

			if (result.status === "completed") {
				if (result.response) parts.push(`\n${result.response}`);
			} else if (result.status === "clarification") {
				parts.push(`Question: ${result.question}`);
				parts.push(`\nTo answer, use bridge_send with session_id: "${result.session_id}"`);
			} else if (result.status === "deferred") {
				parts.push(`Reason: ${result.reason}`);
				if (result.estimated_minutes) parts.push(`Estimated wait: ${result.estimated_minutes} minutes`);
				parts.push("\nYou can use bridge_wait to wait, then retry.");
			} else if (result.status === "needs_human") {
				parts.push(`Reason: ${result.reason}`);
				if (result.what_to_decide) parts.push(`Decision needed: ${result.what_to_decide}`);
				parts.push("\nThe other team needs their human. Inform yours.");
			} else if (result.status === "error") {
				parts.push(`Error: ${result.reason ?? "Unknown error"}`);
			} else if (result.status === "timeout") {
				parts.push(result.message || "No response in time.");
			}

			if (result.session_id) parts.push(`\n[session_id: ${result.session_id}]`);

			return { content: [{ type: "text" as const, text: parts.join("\n") }] };
		} catch (err: any) {
			return { content: [{ type: "text" as const, text: `Failed to send: ${err.message}` }], isError: true };
		}
	},
);

mcpServer.tool(
	"bridge_reply",
	"Reply to an incoming bridge request. Call this once when you are done handling the request.",
	{
		session_id: z
			.string()
			.describe("The session_id from the incoming request header. Required to route the reply correctly."),
		status: z.enum(["completed", "clarification", "deferred", "needs_human"]).describe("The outcome of your work."),
		response: z
			.string()
			.optional()
			.describe("Your full response to the request. Required when status is completed."),
		question: z
			.string()
			.optional()
			.describe("The specific question you need answered. Required when status is clarification."),
		reason: z.string().optional().describe("Why you are deferred or need a human. Required for those statuses."),
		estimated_minutes: z.number().optional().describe("Estimated minutes until you can handle this. For deferred."),
		what_to_decide: z
			.string()
			.optional()
			.describe("The specific decision or approval a human must make. Required for needs_human."),
	},
	async ({ session_id, status, ...rest }) => {
		try {
			await routerPost("/respond", { session_id, status, ...rest });
			console.error(`[bridge-mcp] bridge_reply sent: ${status} [${session_id}]`);
			return { content: [{ type: "text" as const, text: `Reply sent (${status}).` }] };
		} catch (err: any) {
			return {
				content: [{ type: "text" as const, text: `Failed to send reply: ${err.message}` }],
				isError: true,
			};
		}
	},
);

mcpServer.tool(
	"bridge_wait",
	"Wait N seconds before retrying. Use when another team asks you to wait.",
	{ seconds: z.number().min(1).max(1800) },
	async ({ seconds }) => {
		await new Promise((r) => setTimeout(r, seconds * 1000));
		return { content: [{ type: "text" as const, text: `Waited ${seconds}s. You can retry now.` }] };
	},
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
export async function startMcp() {
	ROUTER_URL = process.env.BRIDGE_ROUTER_URL || "http://agent-team-bridge:5678";
	TEAM_NAME = process.env.TEAM_NAME!;
	AGENT_TYPE = process.env.AGENT_TYPE || "claude";
	EFFORT_ENV = {
		simple: process.env.MODEL_SIMPLE || "auto",
		standard: process.env.MODEL_STANDARD || "auto",
		complex: process.env.MODEL_COMPLEX || "auto",
	};

	if (!TEAM_NAME) {
		console.error("TEAM_NAME environment variable is required (set in MCP config)");
		process.exit(1);
	}

	connectToRouter();
	const transport = new StdioServerTransport();
	await mcpServer.connect(transport);
	console.error(`[bridge-mcp] started for ${TEAM_NAME} (agent: ${AGENT_TYPE})`);

	process.stdin.on("end", () => {
		console.error("[bridge-mcp] stdin closed (parent exited), shutting down");
		if (routerWs) routerWs.close();
		process.exit(0);
	});
}
