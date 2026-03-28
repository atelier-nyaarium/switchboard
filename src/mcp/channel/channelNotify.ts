import { appendFileSync, mkdirSync } from "node:fs";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";

// Hypothesis table:
// | ID | Hypothesis                                              | Expected evidence                                              |
// |----|--------------------------------------------------------|----------------------------------------------------------------|
// | A  | response_push received by wrong MCP sub-process        | Multiple PIDs logging recv for same session, only one is active |
// | B  | server.notification() silently fails or throws          | recv logged but emit missing or shows FAILED                    |
// | C  | Notification emitted but Claude Code drops it when idle | Both recv and emit logged as OK, but agent never sees it        |
// | D  | Stale sub-sessions accumulate on arbiter                | Arbiter registry shows subIds from dead MCP processes           |
// | E  | Heartbeat too slow to evict ghosts (60s window)         | Stale subId persists across multiple broadcasts before eviction |
// | F  | MCP reconnect creates new subId without closing old WS  | Old subId remains in registry alongside new subId for same team |

const DEBUG_LOG = "/home/nyaarium/projects/agent-team-bridge/.cursor/debug.log";
const RUN_ID = `debug-${Date.now().toString(36)}`;

function debugLog(location: string, hypothesisId: string, message: string, data: Record<string, unknown>): void {
	try {
		const line = JSON.stringify({
			runId: RUN_ID,
			hypothesisId,
			location,
			message,
			data,
			timestamp: new Date().toISOString(),
		});
		mkdirSync("/home/nyaarium/projects/agent-team-bridge/.cursor", { recursive: true });
		appendFileSync(DEBUG_LOG, `${line}\n`);
	} catch {
		// Silent - debug logging must never break production flow
	}
}

////////////////////////////////
//  Functions & Helpers

/**
 * Emit a channel notification to push an incoming message into Claude's session.
 * The message arrives as a <channel source="bridge" ...>body</channel> tag.
 */
export async function emitChannelNotification(server: Server, payload: ChannelPushPayload): Promise<void> {
	const replyReminder = `
┃ 📫 Reply ONLY via \`channel_reply\`. Do not output additional text outside this tool call.
┃ ➜ session_id: \`${payload.session_id}\`
`.trim();

	// #region Hypothesis A: channel_push received by this sub-process
	debugLog("src/mcp/channel/channelNotify.ts:emitChannelNotification", "A", "channel_push received", {
		pid: process.pid,
		sessionId: payload.session_id.slice(0, 8),
		from: payload.from,
		bodyLen: (payload.body ?? "").length,
	});
	// #endregion

	await server.notification({
		method: "notifications/claude/channel",
		params: {
			content: `${replyReminder}\n\n${payload.body}`,
			meta: {
				session_id: payload.session_id,
				from: payload.from,
				request_type: payload.request_type,
				effort: String(payload.effort),
				is_follow_up: String(payload.is_follow_up),
			},
		},
	});

	// #region Hypothesis B: channel notification emitted successfully
	debugLog("src/mcp/channel/channelNotify.ts:emitChannelNotification", "B", "channel notification emitted", {
		pid: process.pid,
		sessionId: payload.session_id.slice(0, 8),
		result: "OK",
	});
	// #endregion

	console.error(
		`[channel] pushed ${payload.is_follow_up ? "follow-up" : "request"} from ${payload.from} [${payload.session_id.slice(0, 8)}...]`,
	);
}

export async function emitResponseNotification(server: Server, payload: ResponsePushPayload): Promise<void> {
	const parts = [`Status: ${payload.status}`];
	if (payload.response) parts.push(payload.response);
	if (payload.question) parts.push(`Question: ${payload.question}`);
	if (payload.reason) parts.push(`Reason: ${payload.reason}`);

	// #region Hypothesis A: response_push received by this sub-process
	debugLog("src/mcp/channel/channelNotify.ts:emitResponseNotification", "A", "response_push received", {
		pid: process.pid,
		sessionId: payload.session_id.slice(0, 8),
		status: payload.status,
		responseLen: (payload.response ?? "").length,
	});
	// #endregion

	try {
		await server.notification({
			method: "notifications/claude/channel",
			params: {
				content: parts.join("\n"),
				meta: { session_id: payload.session_id, type: "response" },
			},
		});

		// #region Hypothesis B: response notification emitted successfully
		debugLog("src/mcp/channel/channelNotify.ts:emitResponseNotification", "B", "response notification emitted", {
			pid: process.pid,
			sessionId: payload.session_id.slice(0, 8),
			result: "OK",
		});
		// #endregion
	} catch (err) {
		// #region Hypothesis B: server.notification() threw an error
		debugLog("src/mcp/channel/channelNotify.ts:emitResponseNotification", "B", "response notification FAILED", {
			pid: process.pid,
			sessionId: payload.session_id.slice(0, 8),
			error: (err as Error).message,
		});
		// #endregion
		throw err;
	}
	console.error(`[channel] response pushed to sender [${payload.session_id.slice(0, 8)}...]`);
}
