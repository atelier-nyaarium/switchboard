import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import crypto from "crypto";
import WebSocket from "ws";
import { z } from "zod";

const ROUTER_URL = process.env.BRIDGE_ROUTER_URL || "http://agent-team-bridge:5678";
const TEAM_NAME = process.env.PROJECT_NAME;
const AGENT_TYPE = process.env.BRIDGE_AGENT_TYPE || "claude";
const AGENT_TIMEOUT_MS = parseInt(process.env.BRIDGE_AGENT_TIMEOUT_MS || "600000"); // 10 min default

if (!TEAM_NAME) {
	console.error("PROJECT_NAME environment variable is required");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Ingest log — POST to router, append NDJSON in workspace .cursor (no stderr storm)
// ---------------------------------------------------------------------------
async function logIngest(message, data = {}) {
	const payload = { message, data, location: "mcp/server.js", timestamp: Date.now(), team: TEAM_NAME };
	try {
		await fetch(`${ROUTER_URL}/ingest`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (_) {}
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
			if (code === 0) {
				resolve(stdout.trim());
			} else {
				const errText = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || "(no output)";
				reject(new Error(`Agent exited ${code}: ${errText}`));
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Agent handlers — each agent type knows its own CLI
// ---------------------------------------------------------------------------
const AGENT_HANDLERS = {
	claude: {
		async createSession() {
			// Claude Code: generate a UUID, first -p call with --session-id
			// establishes the session.
			return crypto.randomUUID();
		},
		async sendMessage(sessionId, message) {
			return runAgent("claude", ["-p", "--dangerously-skip-permissions", "--session-id", sessionId], message);
		},
	},

	cursor: {
		async createSession() {
			const id = await runAgent("cursor-agent", ["create-chat", "-f"], null);
			return id.trim();
		},
		async sendMessage(sessionId, message) {
			return runAgent("cursor-agent", ["-f", "-p", `--resume=${sessionId}`], message);
		},
	},
};

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function buildInitialPrompt(msg) {
	return `# Cross-Team Request

**From:** ${msg.from}
**Type:** ${msg.request_type}
**Priority:** ${msg.priority}

## Request

${msg.subject ? `**${msg.subject}**\n\n` : ""}${msg.body}

## How to Respond

You are receiving this because another team's agent needs something from this codebase.
Do the work if you can. Ask for clarification if the request is ambiguous. Defer if you're
deep in something else. Escalate if a human needs to decide.

**Your response MUST start with YAML frontmatter.** The bridge parses this to route your answer.

For completed work:
\`\`\`
---
status: completed
summary: Short description of what you did
version: 1.2.3
breaking: false
migration_notes: Optional notes if breaking
---
...Your formatted Markdown response here...
\`\`\`

For clarification needed:
\`\`\`
---
status: clarification
question: Your question here
---
...Your formatted Markdown response here...
\`\`\`

For deferring:
\`\`\`
---
status: deferred
reason: Why you can't do it now
estimated_minutes: 20
---
...Your formatted Markdown response here...
\`\`\`

For human escalation:
\`\`\`
---
status: needs_human
reason: Why a human must decide
what_to_decide: The specific decision
---
...Your formatted Markdown response here...
\`\`\`

After the frontmatter, explain your work in detail. The frontmatter is machine-parsed;
everything after it is context for the requesting agent.
`;
}

function buildFollowUpPrompt(msg) {
	return `# Cross-Team Follow-Up

**From:** ${msg.from}

${msg.body}

(Same format — start with YAML frontmatter, then your detailed response.)
`;
}

// ---------------------------------------------------------------------------
// Parse YAML frontmatter from agent stdout
// ---------------------------------------------------------------------------
function parseAgentResponse(output) {
	const fmMatch = output.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (fmMatch) {
		try {
			const meta = {};
			for (const line of fmMatch[1].split("\n")) {
				const colon = line.indexOf(":");
				if (colon === -1) continue;
				const key = line.slice(0, colon).trim();
				let val = line.slice(colon + 1).trim();

				if (val === "true") val = true;
				else if (val === "false") val = false;
				else if (/^\d+$/.test(val)) val = parseInt(val, 10);

				meta[key] = val;
			}

			if (meta.status) {
				const narrative = output.slice(fmMatch[0].length).trim();
				if (narrative) meta.narrative = narrative;
				return meta;
			}
		} catch {
			/* fall through */
		}
	}

	return {
		status: "error",
		reason: "Bridge could not parse agent response (no valid YAML frontmatter).",
	};
}

// ---------------------------------------------------------------------------
// Handle inbound inject from router (via WebSocket)
// ---------------------------------------------------------------------------
async function handleInject(msg) {
	const handler = AGENT_HANDLERS[AGENT_TYPE];
	if (!handler) {
		console.error(`[bridge-mcp] unknown agent type: "${AGENT_TYPE}"`);
		await routerPost("/respond", {
			callback_id: msg.callback_id,
			status: "error",
			reason: `Agent type "${AGENT_TYPE}" is not a recognized handler. Valid types: ${Object.keys(AGENT_HANDLERS).join(", ")}`,
		});
		return;
	}

	try {
		// If a session_id was provided, this is a follow-up — use it directly.
		// Otherwise create a fresh agent session. No map needed.
		const sessionId = msg.session_id ?? (await handler.createSession());
		const isFollowUp = !!msg.session_id;

		const prompt = isFollowUp ? buildFollowUpPrompt(msg) : buildInitialPrompt(msg);
		console.error(
			`[bridge-mcp] ${isFollowUp ? "follow-up" : "new"} ${AGENT_TYPE} session ${sessionId.slice(0, 8)}... from ${msg.from}`,
		);

		const output = await handler.sendMessage(sessionId, prompt);

		const parsed = parseAgentResponse(output);
		parsed.callback_id = msg.callback_id;
		parsed.session_id = sessionId; // always echo back so caller can thread follow-ups

		console.error(`[bridge-mcp] response: ${parsed.status} [${msg.callback_id}]`);
		await routerPost("/respond", {
			callback_id: msg.callback_id,
			...parsed,
		});
	} catch (err) {
		console.error(`[bridge-mcp] inject failed: ${err.message}`);
		await routerPost("/respond", {
			callback_id: msg.callback_id,
			status: "error",
			reason: err.message,
		});
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
			handleInject(msg);
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
// MCP Tools — exposed to the main agent session via stdio
// ---------------------------------------------------------------------------
const server = new McpServer({
	name: "agent-team-bridge",
	version: "0.2.0",
});

server.tool("bridge_discover", "List all active teams on the bridge network.", {}, async () => {
	try {
		const teams = await routerGet("/teams");
		const others = teams.filter((t) => t.team !== TEAM_NAME);

		if (others.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: "No other teams are currently online.",
					},
				],
			};
		}

		const lines = others.map((t) => {
			const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "available";
			return `- ${t.team}: ${status}`;
		});

		return {
			content: [
				{
					type: "text",
					text: `Teams on the bridge:\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `Failed to reach router: ${err.message}`,
				},
			],
			isError: true,
		};
	}
});

server.tool(
	"bridge_send",
	"Send a request to another team and wait for their response. Blocks until they respond.",
	{
		to: z.string().describe("Target team name"),
		type: z.enum(["feature", "bugfix", "breaking-change", "question"]).default("question"),
		priority: z.enum(["low", "normal", "urgent", "blocking"]).default("normal"),
		subject: z.string().describe("Short summary"),
		body: z.string().describe("Full details"),
		session_id: z
			.string()
			.optional()
			.describe("Agent session ID from a previous response — omit to start a new conversation thread"),
	},
	async ({ to, type, priority, subject, body, session_id }) => {
		try {
			const result = await routerPost("/send", {
				from: TEAM_NAME,
				to,
				type,
				priority,
				subject,
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
				parts.push(`Summary: ${result.summary || "(no summary)"}`);
				if (result.version) parts.push(`Version: ${result.version}`);
				if (result.breaking) parts.push("⚠️ BREAKING CHANGE");
				if (result.migration_notes) parts.push(`Migration: ${result.migration_notes}`);
				if (result.narrative) parts.push(`\nDetails:\n${result.narrative}`);
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
				content: [
					{
						type: "text",
						text: `Failed to send: ${err.message}`,
					},
				],
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
			content: [
				{
					type: "text",
					text: `Waited ${seconds}s. You can retry now.`,
				},
			],
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
