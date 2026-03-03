import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { createServer } from "http";
import WebSocket from "ws";
import { z } from "zod";

const ROUTER_URL = process.env.BRIDGE_ROUTER_URL || "http://agent-team-bridge:5678";
const TEAM_NAME = process.env.TEAM_NAME;
const AGENT_TYPE = process.env.AGENT_TYPE || "claude";
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || "600000"); // 10 min default

if (!TEAM_NAME) {
	console.error("TEAM_NAME environment variable is required (set in MCP config)");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Ingest log — POST to router /ingest (NDJSON to router LOG_PATH).
// ---------------------------------------------------------------------------
async function debugLog(message, data = {}) {
	const payload = { message, data, location: "mcp/server.js", timestamp: Date.now(), team: TEAM_NAME };
	await fetch(`${ROUTER_URL}/ingest`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	}).catch(() => {});
}

// ---------------------------------------------------------------------------
// Run an agent CLI command: stdin → stdout
// ---------------------------------------------------------------------------
async function runAgent(command, args, input) {
	const env = { ...process.env };
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home) {
		const extra = [`${home}/.local/bin`, `${home}/bin`].join(":");
		env.PATH = [env.PATH, extra].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
	}

	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			timeout: AGENT_TIMEOUT_MS,
			cwd: process.cwd(),
			env,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => (stderr += d));

		proc.on("error", (err) => {
			reject(err);
		});

		if (input) {
			proc.stdin.write(input);
			proc.stdin.end();
		}

		proc.on("close", (code) => {
			const outTrimmed = stdout.trim();
			const errTrimmed = stderr.trim();
			if (code === 0) {
				resolve(outTrimmed);
			} else {
				const errText = [errTrimmed, outTrimmed].filter(Boolean).join("\n") || "(no output)";
				reject(new Error(`Agent exited ${code}: ${errText}`));
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Effort → model resolution
//
// install.sh writes MODEL_SIMPLE/STANDARD/COMPLEX into the MCP json as
// logical names (haiku, sonnet, opus, codex, auto). resolveModel() maps those
// logical names to the agent-specific CLI string for the active AGENT_TYPE.
// ---------------------------------------------------------------------------
const EFFORT_ENV = {
	simple: process.env.MODEL_SIMPLE || "auto",
	standard: process.env.MODEL_STANDARD || "auto",
	complex: process.env.MODEL_COMPLEX || "auto",
};

// Logical model name → CLI string per agent type.
// "auto" on Claude = omit --model flag entirely (let Claude Code decide).
const MODEL_STRINGS = {
	claude: {
		auto: "auto",
		haiku: "haiku",
		sonnet: "sonnet",
		opus: "opus",
		codex: "ERROR",
	},
	cursor: {
		auto: "auto",
		haiku: "ERROR",
		sonnet: "sonnet-4.6-thinking",
		opus: "opus-4.6-thinking",
		codex: "gpt-5.3-codex",
	},
};

function resolveModel(effort) {
	const logicalName = EFFORT_ENV[effort ?? "auto"] ?? "auto";

	if (logicalName === "codex" && AGENT_TYPE !== "cursor") {
		throw new Error(
			'Model "codex" is not supported by the Claude agent. ' +
				"Set AGENT_TYPE=cursor in your .cursor/mcp.json to use Codex in Cursor.",
		);
	}

	const agentModels = MODEL_STRINGS[AGENT_TYPE];
	return agentModels?.[logicalName] ?? "auto";
}

// ---------------------------------------------------------------------------
// Agent handlers — each agent type knows its own CLI
// ---------------------------------------------------------------------------
const AGENT_HANDLERS = {
	claude: {
		async createSession(sessionId) {
			return sessionId;
		},
		async sendMessage(sessionId, message, model) {
			const args = ["-p", "--dangerously-skip-permissions", "--model", model, "--session-id", sessionId];
			return runAgent("claude", args, message);
		},
	},

	cursor: {
		async createSession() {
			const id = await runAgent("cursor-agent", ["create-chat", "-f"], null);
			return id.trim();
		},
		async sendMessage(sessionId, message, model) {
			const args = ["-f", "-p", "--model", model, `--resume=${sessionId}`];
			return runAgent("cursor-agent", args, message);
		},
	},
};

// ---------------------------------------------------------------------------
// Reply proxy — so CLI sub-agents (no MCP) can POST their reply to us; we forward to router
// ---------------------------------------------------------------------------
function createReplyProxy(sessionId) {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", async () => {
				try {
					const data = JSON.parse(body);
					if (data.session_id !== sessionId) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "session_id mismatch" }));
						return;
					}
					await routerPost("/respond", data);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ delivered: true }));
					console.error(
						`[bridge-mcp] reply proxy received reply: ${data.status} [${sessionId.slice(0, 8)}...]`,
					);
				} catch (err) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: err.message }));
				} finally {
					server.close();
				}
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			resolve({
				port,
				close: () => {
					if (server.listening) server.close();
				},
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function buildInitialPrompt(msg, replyProxyPort, sessionId) {
	return `┃ CROSS-TEAM COMMUNICATION — USE SKILL: agent-team-bridge - **Receiving a Request**
┃ From: ${msg.from}
┃ Type: ${msg.request_type}
┃ session_id: ${sessionId}
┃ ↳ When finished, call bridge_reply with the session_id above.
┃ If you do NOT have the bridge_reply MCP tool (e.g. CLI agent), submit your reply by POSTing JSON to:
┃   http://127.0.0.1:${replyProxyPort}/respond
┃ Body: { "session_id": "${sessionId}", "status": "completed"|"clarification"|"deferred"|"needs_human", ... }
┃ Example (completed): curl -s -X POST http://127.0.0.1:${replyProxyPort}/respond -H "Content-Type: application/json" -d '{"session_id":"${sessionId}","status":"completed","response":"Your answer here"}'

${msg.body}
`;
}

function buildFollowUpPrompt(msg, replyProxyPort, sessionId) {
	return `┃ CROSS-TEAM COMMUNICATION — USE SKILL: agent-team-bridge - **Receiving a Follow-up**
┃ From: ${msg.from}
┃ session_id: ${sessionId}
┃ ↳ When finished, call bridge_reply with the session_id above.
┃ If you do NOT have bridge_reply, POST your reply to: http://127.0.0.1:${replyProxyPort}/respond (session_id: ${sessionId})

${msg.body}
`;
}

// ---------------------------------------------------------------------------
// Handle inbound inject from router (via WebSocket)
// ---------------------------------------------------------------------------
async function handleInject(msg) {
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

	let replyProxy;
	try {
		replyProxy = await createReplyProxy(sessionId);
	} catch (err) {
		await routerPost("/respond", {
			session_id: sessionId,
			status: "error",
			reason: err.message,
		}).catch(() => {});
		return;
	}

	try {
		const model = resolveModel(msg.effort);
		const isFollowUp = !!msg.is_follow_up;
		const agentSessionId = isFollowUp ? sessionId : await handler.createSession(sessionId);

		const prompt = isFollowUp
			? buildFollowUpPrompt(msg, replyProxy.port, sessionId)
			: buildInitialPrompt(msg, replyProxy.port, sessionId);

		console.error(
			`[bridge-mcp] ${isFollowUp ? "follow-up" : "new"} ${AGENT_TYPE}/${model} session ${sessionId.slice(0, 8)}... from ${msg.from}`,
		);

		await handler.sendMessage(agentSessionId, prompt, model);
	} catch (err) {
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
// WebSocket connection to router — with exponential backoff
// ---------------------------------------------------------------------------
let routerWs = null;
let reconnectTimer = null; // guard: only one reconnect scheduled at a time
let reconnectDelay = 2000; // starts at 2s, doubles each attempt, caps at 30s
const RECONNECT_MAX_MS = 30000;

function scheduleReconnect() {
	if (reconnectTimer) return; // already scheduled — don't stack
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
		routerWs.send(JSON.stringify({ type: "register", team: TEAM_NAME }));
	});

	routerWs.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg.type === "inject") {
			handleInject(msg).catch((err) => {
				console.error(`[bridge-mcp] handleInject error: ${err.message}`);
			});
		}
	});

	routerWs.on("close", () => {
		console.error(`[bridge-mcp] disconnected`);
		scheduleReconnect();
	});

	routerWs.on("error", (err) => {
		console.error(`[bridge-mcp] ws error: ${err.message}`);
	});
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function routerPost(path, body, { retries = 4, retryDelayMs = 1500 } = {}) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(`${ROUTER_URL}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return res.json();
		} catch (err) {
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

async function routerGet(path) {
	const res = await fetch(`${ROUTER_URL}${path}`);
	return res.json();
}

// ---------------------------------------------------------------------------
// MCP Tools — exposed to the agent session via stdio
// ---------------------------------------------------------------------------
const server = new McpServer({
	name: "agent-team-bridge",
	version: "0.3.0",
});

server.tool("bridge_discover", "List all active teams on the bridge network.", {}, async () => {
	try {
		const teams = await routerGet("/teams");
		const others = teams.filter((t) => t.team !== TEAM_NAME);

		if (others.length === 0) {
			return {
				content: [{ type: "text", text: "No other teams are currently online." }],
			};
		}

		const lines = others.map((t) => {
			const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "available";
			return `- ${t.team}: ${status}`;
		});

		return {
			content: [{ type: "text", text: `Teams on the bridge:\n${lines.join("\n")}` }],
		};
	} catch (err) {
		return {
			content: [{ type: "text", text: `Failed to reach router: ${err.message}` }],
			isError: true,
		};
	}
});

server.tool(
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
			const result = await routerPost("/send", {
				from: TEAM_NAME, // TODO: move this into the router server
				to,
				type,
				effort,
				body,
				session_id: session_id || null,
			});

			if (result.error) {
				return {
					content: [
						{
							type: "text",
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

			return {
				content: [{ type: "text", text: parts.join("\n") }],
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Failed to send: ${err.message}` }],
				isError: true,
			};
		}
	},
);

server.tool(
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
			return {
				content: [{ type: "text", text: `Reply sent (${status}).` }],
			};
		} catch (err) {
			return {
				content: [{ type: "text", text: `Failed to send reply: ${err.message}` }],
				isError: true,
			};
		}
	},
);

server.tool(
	"bridge_wait",
	"Wait N seconds before retrying. Use when another team asks you to wait.",
	{ seconds: z.number().min(1).max(1800) },
	async ({ seconds }) => {
		await new Promise((r) => setTimeout(r, seconds * 1000));
		return {
			content: [{ type: "text", text: `Waited ${seconds}s. You can retry now.` }],
		};
	},
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
	connectToRouter();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[bridge-mcp] started for ${TEAM_NAME} (agent: ${AGENT_TYPE})`);
}

main().catch((err) => {
	console.error("[bridge-mcp] fatal:", err);
	process.exit(1);
});
