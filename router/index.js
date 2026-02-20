import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5678;
const LOG_PATH = process.env.BRIDGE_LOG_PATH || path.join("/app", "logs", "debug.log");
const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || "600000");

// ---------------------------------------------------------------------------
// Registry — maps team name → WebSocket
// A connected socket IS registration. Disconnect IS deregistration.
// ---------------------------------------------------------------------------
const registry = new Map(); // team name → WebSocket

// ---------------------------------------------------------------------------
// Mutex (unchanged — same Mutex class as before)
// ---------------------------------------------------------------------------
class Mutex {
	constructor() {
		this.locked = false;
		this.queue = [];
		this.holder = null;
	}

	acquire(callbackId) {
		return new Promise((resolve) => {
			const tryAcquire = () => {
				if (!this.locked) {
					this.locked = true;
					this.holder = callbackId;
					resolve(() => this.release());
				} else {
					this.queue.push(tryAcquire);
				}
			};
			tryAcquire();
		});
	}

	release() {
		this.holder = null;
		if (this.queue.length > 0) {
			this.queue.shift()();
		} else {
			this.locked = false;
		}
	}
}

const targetLocks = new Map();

function getMutex(team) {
	if (!targetLocks.has(team)) {
		targetLocks.set(team, new Mutex());
	}
	return targetLocks.get(team);
}

const activeLocks = new Map(); // callback_id → release function

// ---------------------------------------------------------------------------
// Callback correlator (unchanged)
// ---------------------------------------------------------------------------
const pendingCallbacks = new Map(); // callback_id → { resolve, timer }

// ---------------------------------------------------------------------------
// WebSocket server — containers connect here on startup
// ---------------------------------------------------------------------------
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
	let teamName = null;

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.type === "register") {
			teamName = msg.team;
			registry.set(teamName, ws);
			console.log(`[ws] ${teamName} connected`);
		}
	});

	ws.on("close", () => {
		if (teamName) {
			registry.delete(teamName);
			console.log(`[ws] ${teamName} disconnected`);
		}
	});
});

// ---------------------------------------------------------------------------
// POST /ingest — MCP sends log lines (NDJSON), append to file for debugging
// ---------------------------------------------------------------------------
app.post("/ingest", (req, res) => {
	const payload = req.body && typeof req.body === "object" ? req.body : { message: String(req.body) };
	payload.timestamp = payload.timestamp ?? Date.now();
	const line = JSON.stringify(payload) + "\n";
	try {
		const dir = path.dirname(LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(LOG_PATH, line);
		res.json({ ok: true });
	} catch (err) {
		console.error("[ingest]", err.message);
		res.status(500).json({ ok: false, error: err.message });
	}
});

// ---------------------------------------------------------------------------
// GET /pending — list pending callbacks (for debugging)
// ---------------------------------------------------------------------------
app.get("/pending", (_req, res) => {
	const list = [];
	for (const [id, entry] of pendingCallbacks) {
		list.push({
			callback_id: id,
			from: entry.from,
			to: entry.to,
			subject: entry.subject || "(no subject)",
		});
	}
	res.json(list);
});

// ---------------------------------------------------------------------------
// GET /teams — discovery endpoint
// ---------------------------------------------------------------------------
app.get("/teams", (_req, res) => {
	const teams = [];
	for (const [name] of registry) {
		const lock = targetLocks.get(name);
		teams.push({
			team: name,
			status: "active",
			queue_depth: lock ? lock.queue.length + (lock.locked ? 1 : 0) : 0,
		});
	}
	res.json(teams);
});

// ---------------------------------------------------------------------------
// POST /send — MCP calls this via HTTP. Blocks until target responds.
// ---------------------------------------------------------------------------
app.post("/send", async (req, res) => {
	const { from, to, type, priority, subject, body, follow_up_to } = req.body;

	const targetWs = registry.get(to);
	if (!targetWs || targetWs.readyState !== 1) {
		return res.status(404).json({
			error: `Team "${to}" is not connected`,
			available: [...registry.keys()],
		});
	}

	const callbackId = crypto.randomUUID();
	let release;

	try {
		// Acquire or reuse mutex
		if (!follow_up_to) {
			const mutex = getMutex(to);
			release = await mutex.acquire(callbackId);
			activeLocks.set(callbackId, release);
			console.log(`[mutex] ${to} locked by ${callbackId} (from ${from})`);
		} else {
			release = activeLocks.get(follow_up_to);
			if (release) {
				activeLocks.set(callbackId, release);
			}
		}

		// Set up callback listener
		const responsePromise = new Promise((resolve) => {
			const timer = setTimeout(() => {
				pendingCallbacks.delete(callbackId);
				resolve({
					status: "timeout",
					message: `No response from ${to} within ${RESPONSE_TIMEOUT_MS / 1000}s`,
				});
			}, RESPONSE_TIMEOUT_MS);

			pendingCallbacks.set(callbackId, { resolve, timer, from, to, subject });
		});

		// Push message down the target's WebSocket
		const payload = {
			type: "inject",
			from,
			request_type: type || "question",
			priority: priority || "normal",
			subject: subject || "",
			body: body || "",
			callback_id: callbackId,
			follow_up_to: follow_up_to || null,
		};

		console.log(`[send] ${from} → ${to}: ${subject || "(no subject)"} [${callbackId}]`);
		targetWs.send(JSON.stringify(payload));

		// Block until response
		const response = await responsePromise;

		// Release mutex if terminal
		const isTerminal = ["completed", "deferred", "needs_human"].includes(response.status);
		if (isTerminal && release) {
			console.log(`[mutex] ${to} released (conversation complete)`);
			release();
			activeLocks.delete(callbackId);
			if (follow_up_to) activeLocks.delete(follow_up_to);
		}

		res.json(response);
	} catch (err) {
		console.error(`[send] Error:`, err.message);
		if (release) {
			release();
			activeLocks.delete(callbackId);
		}
		res.status(500).json({ error: err.message });
	}
});

// ---------------------------------------------------------------------------
// POST /respond — MCP calls this via HTTP when agent responds
// ---------------------------------------------------------------------------
app.post("/respond", (req, res) => {
	const { callback_id, ...response } = req.body;

	if (!callback_id) {
		return res.status(400).json({ error: "callback_id is required" });
	}

	const pending = pendingCallbacks.get(callback_id);
	if (!pending) {
		return res.status(404).json({
			error: `No pending request for callback_id "${callback_id}"`,
		});
	}

	clearTimeout(pending.timer);
	pendingCallbacks.delete(callback_id);
	pending.resolve(response);

	console.log(`[respond] ${callback_id} → ${response.status}`);
	res.json({ delivered: true });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
	res.json({
		ok: true,
		teams: registry.size,
		pending_callbacks: pendingCallbacks.size,
	});
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
	console.log(`[router] listening on :${PORT} (HTTP + WebSocket)`);
});
