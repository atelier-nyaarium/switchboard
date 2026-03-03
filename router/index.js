import crypto from "crypto";
import express from "express";
import fs from "fs";
import { createServer } from "http";
import path from "path";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5678;
const LOG_PATH = path.join("/app", "log", "debug.log");
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

const pendingCallbacks = new Map(); // session_id → { resolve, timer }

// ---------------------------------------------------------------------------
// WebSocket server — containers connect here on startup
// ---------------------------------------------------------------------------
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Heartbeat — ping all clients every 30s. Clients that miss 2 consecutive
// pongs (~60s) are terminated, triggering the normal close handler and
// removing the team from the registry.
const HEARTBEAT_INTERVAL_MS = 30000;
const MISSED_PINGS_LIMIT = 2;
setInterval(() => {
	for (const ws of wss.clients) {
		ws.missedPings = (ws.missedPings || 0) + 1;
		if (ws.missedPings >= MISSED_PINGS_LIMIT) {
			ws.terminate();
			continue;
		}
		ws.ping();
	}
}, HEARTBEAT_INTERVAL_MS);

wss.on("connection", (ws) => {
	ws.missedPings = 0;
	ws.on("pong", () => {
		ws.missedPings = 0;
	});

	let teamName = null;

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.type === "register") {
			// If a different socket is already registered for this team, close it cleanly
			// so its close-handler doesn't later clobber the new registration.
			const existing = registry.get(msg.team);
			if (existing && existing !== ws) {
				console.log(`[ws] ${msg.team} re-registered — closing stale socket`);
				existing.close();
			}
			teamName = msg.team;
			registry.set(teamName, ws);
			console.log(`[ws] ${teamName} connected`);
		}
	});

	ws.on("close", () => {
		if (!teamName) return;

		// Only clean up if this socket is still the current one for this team.
		// If the team reconnected before this close fired, the registry already
		// points to the new socket — don't touch it.
		if (registry.get(teamName) !== ws) {
			console.log(`[ws] stale close for ${teamName} — new socket already registered, skipping cleanup`);
			return;
		}

		registry.delete(teamName);
		console.log(`[ws] ${teamName} disconnected`);

		// Immediately fail all pending callbacks waiting on this team so callers
		// get an error response right away instead of hanging until timeout.
		for (const [id, entry] of pendingCallbacks) {
			if (entry.to === teamName) {
				clearTimeout(entry.timer);
				pendingCallbacks.delete(id);
				entry.resolve({
					status: "error",
					message: `Team "${teamName}" disconnected before responding`,
				});
				console.log(`[ws] cancelled pending session ${id} (${teamName} disconnected)`);
			}
		}

		// Force-release the mutex so any senders queued behind this team's lock
		// get unblocked. They'll each hit the 404 "not connected" path cleanly.
		const mutex = targetLocks.get(teamName);
		if (mutex && mutex.locked) {
			console.log(`[mutex] force-releasing ${teamName} after disconnect`);
			mutex.release();
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
	for (const [sessionId, entry] of pendingCallbacks) {
		list.push({ session_id: sessionId, from: entry.from, to: entry.to });
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
	const { from, to, type, effort, body, session_id } = req.body;

	const targetWs = registry.get(to);
	if (!targetWs || targetWs.readyState !== 1) {
		return res.status(404).json({
			error: `Team "${to}" is not connected`,
			available: [...registry.keys()],
		});
	}

	const sessionId = session_id || crypto.randomUUID();
	let release;

	try {
		const mutex = getMutex(to);
		release = await mutex.acquire(sessionId);

		console.log(`[mutex] ${to} locked by ${sessionId} (from ${from})`);

		const responsePromise = new Promise((resolve) => {
			const timer = setTimeout(() => {
				pendingCallbacks.delete(sessionId);
				resolve({
					status: "timeout",
					message: `No response from ${to} within ${RESPONSE_TIMEOUT_MS / 1000}s`,
				});
			}, RESPONSE_TIMEOUT_MS);

			pendingCallbacks.set(sessionId, { resolve, timer, from, to });
		});

		const payload = {
			type: "inject",
			from,
			request_type: type || "question",
			body: body || "",
			effort: effort || "auto",
			session_id: sessionId,
			is_follow_up: !!session_id,
		};

		console.log(`[send] ${from} → ${to} [${sessionId}]`);

		// Re-check readyState immediately before sending — team may have disconnected
		// in the window between the registry lookup above and now.
		if (targetWs.readyState !== 1) {
			throw new Error(`Team "${to}" disconnected before message could be delivered`);
		}
		targetWs.send(JSON.stringify(payload));

		// Block until response
		const response = await responsePromise;

		// Release mutex so the next /send can run
		if (release) {
			console.log(`[mutex] ${to} released [${response.status}]`);
			release();
		}

		res.json(response);
	} catch (err) {
		console.error(`[send] Error:`, err.message);
		if (release) {
			release();
		}
		res.status(500).json({ error: err.message });
	}
});

// ---------------------------------------------------------------------------
// POST /respond — MCP calls this via HTTP when agent responds
// ---------------------------------------------------------------------------
app.post("/respond", (req, res) => {
	const { session_id: respondSessionId, ...response } = req.body;

	if (!respondSessionId) {
		return res.status(400).json({ error: "session_id is required" });
	}

	const pending = pendingCallbacks.get(respondSessionId);
	if (!pending) {
		return res.status(404).json({
			error: `No pending request for session_id "${respondSessionId}"`,
		});
	}

	clearTimeout(pending.timer);
	pendingCallbacks.delete(respondSessionId);
	pending.resolve(response);

	console.log(`[respond] ${respondSessionId} → ${response.status}`);
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
