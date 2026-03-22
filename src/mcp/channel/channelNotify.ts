import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChannelPushPayload } from "../../shared/types.js";

////////////////////////////////
//  Functions & Helpers

/**
 * Emit a channel notification to push an incoming message into Claude's session.
 * The message arrives as a <channel source="bridge" ...>body</channel> tag.
 */
export async function emitChannelNotification(server: Server, payload: ChannelPushPayload): Promise<void> {
	await server.notification({
		method: "notifications/claude/channel",
		params: {
			content: payload.body,
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
