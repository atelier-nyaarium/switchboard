import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReplyTool } from "../bridge/replyTool.js";

export function registerChannelReply(mcpServer: McpServer): void {
	registerReplyTool(
		mcpServer,
		"channel_reply",
		"Channel Reply",
		`Reply to an incoming channel message. The channel conversation stays open, so you can call this multiple times on the same session_id: use status "running" for interim progress updates (phase reports, partial results, acknowledgements) and status "completed" when you have delivered the final answer. The conversation is only truly closed when your process exits. Send responses verbatim unless the requester explicitly asked for a summary.`,
		"channel",
	);
}
