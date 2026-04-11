import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChannelReplySchema } from "../../shared/schemas.js";
import { registerReplyTool } from "../bridge/replyTool.js";

export function registerChannelReply(mcpServer: McpServer): void {
	registerReplyTool(
		mcpServer,
		"channel_reply",
		"Channel Reply",
		`Reply to an incoming channel message. Channel conversations are streams — you can call this any number of times on the same session_id. Each call is just another message in the stream; there is no finality or "done" status. Send responses verbatim unless the requester explicitly asked for a summary.`,
		"channel",
		ChannelReplySchema,
	);
}
