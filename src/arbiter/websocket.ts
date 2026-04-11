import type { ServerWebSocket } from "bun";
import { debugLog } from "../shared/debug-log.js";
import type { Mutex } from "../shared/mutex.js";
import type { PendingJobStore } from "../shared/pending-job-store.js";
import type { ConnectionMode, ResponsePayload, WebSocketConfig } from "../shared/types.js";
import type { WakeCoordinator } from "./wake.js";

////////////////////////////////
//  Interfaces & Types

export type TeamRegistry = Map<string, Map<string, ServerWebSocket<WsData>>>;
export type ConversationRegistry = Map<string, ServerWebSocket<WsData>>;

export interface WebSocketDeps {
	registry: TeamRegistry;
	conversationRegistry: ConversationRegistry;
	store: PendingJobStore<ResponsePayload>;
	targetLocks: Map<string, Mutex>;
	knownTeamPaths: Map<string, string>;
	offlineCatalog: Map<string, string>;
	wakeCoordinator: WakeCoordinator;
	config: WebSocketConfig;
	onTeamConnect?: (team: string, ws: ServerWebSocket<WsData>) => void;
}

export interface WsData {
	teamName: string | null;
	subId: string;
	conversationId: string | null;
	mode: ConnectionMode;
	missedPings: number;
	isStale: boolean;
	handshakeConfirmed: boolean;
	proxyProject?: string;
	proxyAuth?: string;
}

////////////////////////////////
//  Functions & Helpers

export function getAllActiveWs(subs: Map<string, ServerWebSocket<WsData>>): ServerWebSocket<WsData>[] {
	const result: ServerWebSocket<WsData>[] = [];
	for (const [, ws] of subs) {
		if (ws.readyState === 1) result.push(ws);
	}
	return result;
}

export function createWebSocketHandlers({
	registry,
	conversationRegistry,
	store,
	targetLocks,
	knownTeamPaths,
	offlineCatalog,
	wakeCoordinator,
	config,
	onTeamConnect,
}: WebSocketDeps) {
	const { HEARTBEAT_INTERVAL_MS = 30000, MISSED_PINGS_LIMIT = 2 } = config;

	const heartbeatInterval = setInterval(() => {
		for (const [teamName, subs] of registry) {
			for (const [subId, ws] of subs) {
				const data = ws.data as WsData;
				data.missedPings = (data.missedPings || 0) + 1;
				if (data.missedPings >= MISSED_PINGS_LIMIT) {
					// #region Hypothesis E: heartbeat evicting stale socket
					debugLog("E", "src/arbiter/websocket.ts:heartbeat", "evicting stale socket", {
						team: teamName,
						subId,
						missedPings: data.missedPings,
						readyState: ws.readyState,
						totalSubsForTeam: subs.size,
					});
					// #endregion
					ws.close();
					continue;
				}
				ws.ping();
			}
		}
	}, HEARTBEAT_INTERVAL_MS);

	// Maps handshake session_id -> { team, subId } so we can resolve handshake responses
	const handshakePending = new Map<string, { team: string; subId: string }>();

	function open(ws: ServerWebSocket<WsData>): void {
		ws.data.missedPings = 0;
		ws.data.isStale = false;
		ws.data.handshakeConfirmed = false;
		ws.data.conversationId = null;
	}

	function message(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			return;
		}

		if (msg.type === "register") {
			const team = msg.team as string;
			const subId = (msg.subId as string) || crypto.randomUUID().slice(0, 8);
			const mode = (msg.mode === "channel" ? "channel" : "cli") as ConnectionMode;
			const conversationId = (msg.conversationId as string | undefined) ?? null;

			let subs = registry.get(team);
			if (!subs) {
				subs = new Map();
				registry.set(team, subs);
			}

			// If this subId already exists with a different socket, close the old one
			const existing = subs.get(subId);
			if (existing && existing !== ws) {
				existing.data.isStale = true;
				existing.close();
			}

			// #region Hypothesis D/F: log register with pre-existing sub-session state
			debugLog("D", "src/arbiter/websocket.ts:register", "team registered", {
				team,
				subId,
				mode,
				conversationId: conversationId ?? "none",
				existingSubIds: Array.from(subs.keys()),
				existingSubCount: subs.size,
				replacedExisting: !!existing,
			});
			// #endregion

			ws.data.teamName = team;
			ws.data.subId = subId;
			ws.data.conversationId = conversationId;
			ws.data.mode = mode;
			subs.set(subId, ws);

			if (conversationId) {
				const priorConversationWs = conversationRegistry.get(conversationId);
				if (priorConversationWs && priorConversationWs !== ws && priorConversationWs.readyState === 1) {
					priorConversationWs.data.isStale = true;
					priorConversationWs.close();
				}
				conversationRegistry.set(conversationId, ws);
			}

			if (typeof msg.projectPath === "string" && msg.projectPath) {
				knownTeamPaths.set(team, msg.projectPath);
			}

			wakeCoordinator.notify(team);
			console.log(`[ws] ${team}/${subId} connected (mode: ${mode})`);

			// Handshake: ask channel-mode connections if they are the main/lead agent
			if (mode === "channel" && team !== "__host__") {
				const hsSessionId = `hs-${crypto.randomUUID().slice(0, 8)}`;
				handshakePending.set(hsSessionId, { team, subId });
				ws.send(
					JSON.stringify({
						type: "channel_push",
						from: "__arbiter__",
						request_type: "question",
						body: `This is the initial bridge handshake. Reply via \`channel_reply\` using the session_id shown above.\n\nSet \`replyAsJson: { isMainOrLead: true }\` if you are the primary session or team lead.\nSet \`replyAsJson: { isMainOrLead: false }\` if you are a worker agent spawned by another agent.\n\nDo not use \`crosstalk_send\` — use \`channel_reply\` with status \`"completed"\` and the replyAsJson field.`,
						effort: "simple",
						session_id: hsSessionId,
						is_follow_up: false,
						replyJsonSchema: "{ isMainOrLead: bool }",
					}),
				);
				console.log(`[ws] handshake sent to ${team}/${subId} [${hsSessionId}]`);
			} else {
				ws.data.handshakeConfirmed = true;
			}

			onTeamConnect?.(team, ws);
		}

		// #region Hypothesis M: log all wake_results (arbiter only handles success=false)
		if (msg.type === "wake_result" && typeof msg.team === "string") {
			debugLog("M", "src/arbiter/websocket.ts:wake_result", "wake_result received", {
				team: msg.team as string,
				success: msg.success as boolean,
				error: (msg.error as string) ?? null,
				screen: typeof msg.screen === "string" ? (msg.screen as string).slice(0, 200) : null,
			});
			if (msg.success === false) {
				wakeCoordinator.notify(msg.team, false);
			}
		}
		// #endregion

		if (msg.type === "catalog" && ws.data.teamName === "__host__") {
			const projects = msg.projects;
			if (Array.isArray(projects)) {
				offlineCatalog.clear();
				for (const p of projects) {
					if (typeof p.team === "string" && typeof p.projectPath === "string") {
						offlineCatalog.set(p.team, p.projectPath);
						if (!knownTeamPaths.has(p.team)) {
							knownTeamPaths.set(p.team, p.projectPath);
						}
					}
				}
				console.log(`[ws] catalog received: ${offlineCatalog.size} projects`);
			}
		}

		// Reset missed pings on any message (acts like pong)
		ws.data.missedPings = 0;
	}

	function close(ws: ServerWebSocket<WsData>): void {
		const teamName = ws.data.teamName;
		const subId = ws.data.subId;

		// #region Hypothesis D: log close event with registry state
		if (teamName && teamName !== "__host__") {
			const subs = registry.get(teamName);
			debugLog("D", "src/arbiter/websocket.ts:close", "socket closing", {
				team: teamName,
				subId,
				isStale: ws.data.isStale,
				readyState: ws.readyState,
				subsBeforeClose: subs ? Array.from(subs.keys()) : [],
				subsCount: subs?.size ?? 0,
			});
		}
		// #endregion

		if (ws.data.isStale) {
			console.log(`[ws] stale socket closed for ${teamName}/${subId} - ignoring`);
			return;
		}

		if (!teamName) return;

		if (teamName === "__host__") {
			const subs = registry.get(teamName);
			if (subs) {
				subs.delete(subId);
				if (subs.size === 0) registry.delete(teamName);
			}
			const hostConversationId = ws.data.conversationId;
			if (hostConversationId && conversationRegistry.get(hostConversationId) === ws) {
				conversationRegistry.delete(hostConversationId);
			}
			offlineCatalog.clear();
			console.log(`[ws] __host__ disconnected - offline catalog cleared`);
			return;
		}

		const subs = registry.get(teamName);
		if (!subs) return;

		// Only remove if this is the registered socket for this subId
		if (subs.get(subId) !== ws) {
			console.log(`[ws] stale close for ${teamName}/${subId} - skipping cleanup`);
			return;
		}

		subs.delete(subId);
		console.log(`[ws] ${teamName}/${subId} disconnected (${subs.size} remaining)`);

		// Clear conversation registry entry if it still points at this ws.
		const closingConversationId = ws.data.conversationId;
		if (closingConversationId && conversationRegistry.get(closingConversationId) === ws) {
			conversationRegistry.delete(closingConversationId);
		}

		// If team has no more sub-sessions, clean up fully
		if (subs.size === 0) {
			registry.delete(teamName);

			// Cancel only transient (CLI-mode) pending jobs. Persistent channel conversations
			// stay alive so the conversation resumes cleanly when the team reconnects.
			for (const id of store.getTransientIdsForTeam(teamName)) {
				store.deliver(id, {
					session_id: id,
					status: "error",
					message: `Team "${teamName}" disconnected before responding`,
				} as ResponsePayload);
				console.log(`[ws] cancelled pending session ${id} (${teamName} disconnected)`);
			}

			const mutex = targetLocks.get(teamName);
			if (mutex?.locked) {
				console.log(`[mutex] force-releasing ${teamName} after disconnect`);
				mutex.release();
			}
		}
	}

	/** Resolve a handshake response. Returns true if it was a handshake session. */
	function resolveHandshake(sessionId: string, replyAsJson?: Record<string, unknown>, response?: string): boolean {
		const pending = handshakePending.get(sessionId);
		if (!pending) return false;
		handshakePending.delete(sessionId);

		const subs = registry.get(pending.team);
		const ws = subs?.get(pending.subId);
		if (!ws) return true;

		// Determine if this agent claims to be the lead
		let isMainOrLead = false;
		if (replyAsJson && typeof replyAsJson.isMainOrLead === "boolean") {
			isMainOrLead = replyAsJson.isMainOrLead;
		} else if (response) {
			isMainOrLead = /true/i.test(response);
		}

		// #region Hypothesis G: log resolveHandshake inputs and result
		debugLog("G", "src/arbiter/websocket.ts:resolveHandshake", "handshake resolution", {
			sessionId,
			team: pending.team,
			subId: pending.subId,
			replyAsJson: replyAsJson ?? null,
			response: response ?? null,
			isMainOrLead,
			replyAsJsonType: typeof replyAsJson,
			fieldType: replyAsJson ? typeof replyAsJson.isMainOrLead : "n/a",
		});
		// #endregion

		if (isMainOrLead) {
			ws.data.handshakeConfirmed = true;
			console.log(`[ws] handshake confirmed: ${pending.team}/${pending.subId} is lead`);
		} else {
			console.log(`[ws] handshake rejected: ${pending.team}/${pending.subId} is worker, closing`);
			ws.data.isStale = true;
			ws.send(JSON.stringify({ type: "handshake_reject" }));
			ws.close();
		}
		return true;
	}

	return { open, message, close, heartbeatInterval, resolveHandshake };
}
