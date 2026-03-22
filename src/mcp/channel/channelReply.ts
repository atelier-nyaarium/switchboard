import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReplyTool } from "../bridge/replyTool.js";

export function registerChannelReply(mcpServer: McpServer): void {
	registerReplyTool(
		mcpServer,
		"channel_reply",
		"Channel Reply",
		`Reply to an incoming channel message. Call this once when you are done handling the request from the <channel> tag.`,
		"channel",
	);
}
