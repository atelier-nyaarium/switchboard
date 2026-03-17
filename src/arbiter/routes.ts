import type { ServerWebSocket } from "bun";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Mutex } from "../shared/mutex.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import type { ArbiterConfig, ResponsePayload, TeamInfo } from "../shared/types.js";
import type { WsData } from "./websocket.js";

////////////////////////////////
//  Interfaces & Types

export interface RoutesDeps {
	registry: Map<string, ServerWebSocket<WsData>>;
	store: PendingJobStore<ResponsePayload>;
	getMutex: ((team: string) => Mutex) & { peek: (team: string) => Mutex | undefined };
	tryWakeTeam: (team: string) => Promise<boolean>;
	config: ArbiterConfig;
}

interface SendRequestBody {
	from: string;
	to: string;
	type?: string;
	effort?: string;
	body?: string;
	session_id?: string;
	debug?: boolean;
}

////////////////////////////////
//  Functions & Helpers

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function createRoutes({ registry, store, getMutex, tryWakeTeam, config }: RoutesDeps) {
	const { LOG_PATH, RESPONSE_TIMEOUT_MS } = config;

	function ingest(req: Request, body: Record<string, unknown>): Response {
		const payload: Record<string, unknown> = body && typeof body === "object" ? body : { message: String(body) };
		payload.timestamp = payload.timestamp ?? Date.now();
		const line = `${JSON.stringify(payload)}\n`;
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(LOG_PATH, line);
			return jsonResponse({ ok: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[ingest]`, message);
			return jsonResponse({ ok: false, error: message }, 500);
		}
	}

	function pending(): Response {
		const list = store.listAll().map((e) => ({
			session_id: e.id,
			from: e.from,
			to: e.to,
			state: e.state,
		}));
		return jsonResponse(list);
	}

	function teams(): Response {
		const teamsList: TeamInfo[] = [];
		for (const [name] of registry) {
			if (name === "__host__") continue;
			const lock = getMutex.peek(name);
			teamsList.push({
				team: name,
				status: "active",
				queue_depth: lock ? lock.queue.length + (lock.locked ? 1 : 0) : 0,
			});
		}
		return jsonResponse(teamsList);
	}

	async function send(req: Request, body: Record<string, unknown>): Promise<Response> {
		const { from, to, type, effort, body: msgBody, session_id, debug } = body as unknown as SendRequestBody;

		if (to === "__host__") {
			return jsonResponse({ error: `"__host__" is not a team` }, 400);
		}

		let targetWs = registry.get(to);

		// If offline, attempt to wake the container
		if (!targetWs || targetWs.readyState !== 1) {
			const woken = await tryWakeTeam(to);
			if (woken) {
				targetWs = registry.get(to);
			}
		}

		if (!targetWs || targetWs.readyState !== 1) {
			return jsonResponse(
				{
					error: `Team "${to}" is not connected`,
					available: [...registry.keys()].filter((k) => k !== "__host__"),
				},
				404,
			);
		}

		const sessionId = session_id || crypto.randomUUID();
		let release: (() => void) | undefined;

		try {
			const mutex = getMutex(to);
			release = await mutex.acquire(sessionId);

			console.log(`[mutex] ${to} locked by ${sessionId} (from ${from})`);

			store.create(sessionId, from, to);

			const payload = {
				type: "inject",
				from,
				request_type: type || "question",
				body: msgBody || "",
				effort: effort || "auto",
				session_id: sessionId,
				is_follow_up: !!session_id,
			};

			if (targetWs.readyState !== 1) {
				throw new Error(`Team "${to}" disconnected before message could be delivered`);
			}
			targetWs.send(JSON.stringify(payload));

			const waitResult = await store.waitForResult(sessionId, RESPONSE_TIMEOUT_MS);

			if (release) {
				console.log(`[mutex] ${to} released [${waitResult.delivered ? "delivered" : "running"}]`);
				release();
			}

			if (waitResult.delivered && waitResult.result) {
				const response = waitResult.result;
				if (debug) {
					return jsonResponse({ ...response, session_id: sessionId, from, to, is_follow_up: !!session_id });
				}
				return jsonResponse(response);
			}

			return jsonResponse({
				session_id: sessionId,
				status: "running",
				message: `No response from ${to} within ${RESPONSE_TIMEOUT_MS / 1000}s. Poll with session_id to check later.`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[send] Error:`, message);
			if (release) release();
			return jsonResponse({ error: message }, 500);
		}
	}

	function respond(req: Request, body: Record<string, unknown>): Response {
		const { session_id: respondSessionId, ...response } = body as { session_id?: string; [key: string]: unknown };

		if (!respondSessionId) {
			return jsonResponse({ error: `session_id is required` }, 400);
		}

		const delivered = store.deliver(respondSessionId, response as unknown as ResponsePayload);
		if (!delivered) {
			return jsonResponse({ error: `No pending request for session_id "${respondSessionId}"` }, 404);
		}

		console.log(`[respond] ${respondSessionId} → ${(response as Record<string, unknown>).status}`);
		return jsonResponse({ delivered: true });
	}

	function poll(req: Request, body: Record<string, unknown>): Response {
		const { session_id } = body as { session_id?: string };

		if (!session_id) {
			return jsonResponse({ error: `session_id is required` }, 400);
		}

		const result = store.poll(session_id);

		if (result === undefined) {
			return jsonResponse({ error: `No pending job for session_id "${session_id}"` }, 404);
		}

		if (result === null) {
			return jsonResponse({
				session_id,
				status: "running",
				message: `Job is still running. Poll again later.`,
			});
		}

		return jsonResponse(result);
	}

	function health(): Response {
		return jsonResponse({
			ok: true,
			teams: registry.size,
			pending_jobs: store.size,
		});
	}

	return { ingest, pending, teams, send, respond, poll, health };
}
