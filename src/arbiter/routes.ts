import crypto from "crypto";
import fs from "fs";
import path from "path";

import type { ServerWebSocket } from "bun";
import { Mutex } from "../shared/mutex.js";
import type { ArbiterConfig, PendingEntry, ResponsePayload, TeamInfo } from "../shared/types.js";

export interface RoutesDeps {
	registry: Map<string, ServerWebSocket<{ teamName: string | null }>>;
	pendingCallbacks: Map<string, PendingEntry>;
	getMutex: ((team: string) => Mutex) & { peek: (team: string) => Mutex | undefined };
	config: ArbiterConfig;
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function createRoutes({ registry, pendingCallbacks, getMutex, config }: RoutesDeps) {
	const { LOG_PATH, RESPONSE_TIMEOUT_MS } = config;

	function ingest(req: Request, body: Record<string, unknown>): Response {
		const payload: Record<string, unknown> = body && typeof body === "object" ? body : { message: String(body) };
		payload.timestamp = payload.timestamp ?? Date.now();
		const line = JSON.stringify(payload) + "\n";
		try {
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(LOG_PATH, line);
			return jsonResponse({ ok: true });
		} catch (err: any) {
			console.error("[ingest]", err.message);
			return jsonResponse({ ok: false, error: err.message }, 500);
		}
	}

	function pending(): Response {
		const list: { session_id: string; from: string; to: string }[] = [];
		for (const [sessionId, entry] of pendingCallbacks) {
			list.push({ session_id: sessionId, from: entry.from, to: entry.to });
		}
		return jsonResponse(list);
	}

	function teams(): Response {
		const teamsList: TeamInfo[] = [];
		for (const [name] of registry) {
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
		const { from, to, type, effort, body: msgBody, session_id, debug } = body as {
			from: string;
			to: string;
			type?: string;
			effort?: string;
			body?: string;
			session_id?: string;
			debug?: boolean;
		};

		const targetWs = registry.get(to as string);
		if (!targetWs || targetWs.readyState !== 1) {
			return jsonResponse(
				{
					error: `Team "${to}" is not connected`,
					available: [...registry.keys()],
				},
				404,
			);
		}

		const sessionId = session_id || crypto.randomUUID();
		let release: (() => void) | undefined;

		try {
			const mutex = getMutex(to as string);
			release = await mutex.acquire(sessionId);

			console.log(`[mutex] ${to} locked by ${sessionId} (from ${from})`);

			const responsePromise = new Promise<ResponsePayload>((resolve) => {
				const timer = setTimeout(() => {
					pendingCallbacks.delete(sessionId);
					resolve({
						session_id: sessionId,
						status: "timeout",
						message: `No response from ${to} within ${RESPONSE_TIMEOUT_MS / 1000}s`,
					});
				}, RESPONSE_TIMEOUT_MS);

				pendingCallbacks.set(sessionId, { resolve, timer, from: from as string, to: to as string });
			});

			const payload = {
				type: "inject",
				from,
				request_type: type || "question",
				body: msgBody || "",
				effort: effort || "auto",
				session_id: sessionId,
				is_follow_up: !!session_id,
			};

			console.log(`[send] ${from} → ${to} [${sessionId}]`);

			if (targetWs.readyState !== 1) {
				throw new Error(`Team "${to}" disconnected before message could be delivered`);
			}
			targetWs.send(JSON.stringify(payload));

			const response = await responsePromise;

			if (release) {
				console.log(`[mutex] ${to} released [${response.status}]`);
				release();
			}

			if (debug) {
				return jsonResponse({ ...response, session_id: sessionId, from, to, is_follow_up: !!session_id });
			}
			return jsonResponse(response);
		} catch (err: any) {
			console.error(`[send] Error:`, err.message);
			if (release) release();
			return jsonResponse({ error: err.message }, 500);
		}
	}

	function respond(req: Request, body: Record<string, unknown>): Response {
		const { session_id: respondSessionId, ...response } = body as { session_id?: string; [key: string]: unknown };

		if (!respondSessionId) {
			return jsonResponse({ error: "session_id is required" }, 400);
		}

		const pendingEntry = pendingCallbacks.get(respondSessionId);
		if (!pendingEntry) {
			return jsonResponse({ error: `No pending request for session_id "${respondSessionId}"` }, 404);
		}

		clearTimeout(pendingEntry.timer);
		pendingCallbacks.delete(respondSessionId);
		pendingEntry.resolve(response as ResponsePayload);

		console.log(`[respond] ${respondSessionId} → ${(response as any).status}`);
		return jsonResponse({ delivered: true });
	}

	function health(): Response {
		return jsonResponse({
			ok: true,
			teams: registry.size,
			pending_callbacks: pendingCallbacks.size,
		});
	}

	return { ingest, pending, teams, send, respond, health };
}
