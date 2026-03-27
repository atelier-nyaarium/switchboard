import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChannelPushPayload, ResponsePushPayload } from "../../shared/types.js";

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

	console.error(
		`[channel] pushed ${payload.is_follow_up ? "follow-up" : "request"} from ${payload.from} [${payload.session_id.slice(0, 8)}...]`,
	);
}

export async function emitResponseNotification(server: Server, payload: ResponsePushPayload): Promise<void> {
	const parts = [`Status: ${payload.status}`];
	if (payload.response) parts.push(payload.response);
	if (payload.question) parts.push(`Question: ${payload.question}`);
	if (payload.reason) parts.push(`Reason: ${payload.reason}`);

	await server.notification({
		method: "notifications/claude/channel",
		params: {
			content: parts.join("\n"),
			meta: { session_id: payload.session_id, type: "response" },
		},
	});
	console.error(`[channel] response pushed to sender [${payload.session_id.slice(0, 8)}...]`);
}
