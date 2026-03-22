import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BridgeReplyArgs, BridgeReplySchema } from "../../shared/schemas.js";
import { routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

/**
 * Register the channel_reply tool for Claude's channel-based communication.
 * Claude calls this to reply to incoming <channel source="bridge"> events.
 */
export function registerChannelReply(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"channel_reply",
		{
			title: "Channel Reply",
			description: `Reply to an incoming channel message. Call this once when you are done handling the request from the <channel> tag.`,
			// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
			inputSchema: BridgeReplySchema.shape as any,
		},
		async ({ session_id, status, ...rest }: BridgeReplyArgs) => {
			try {
				await routerPost("/respond", { session_id, status, ...rest });
				console.error(`[channel] channel_reply sent: ${status} [${session_id}]`);
				return { content: [{ type: "text" as const, text: `Reply sent (${status}).` }] };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to send reply: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
