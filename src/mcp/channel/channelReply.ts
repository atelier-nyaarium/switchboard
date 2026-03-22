import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Schemas

const ChannelReplySchema = z.object({
	session_id: z
		.string()
		.describe(`The session_id from the <channel> tag attributes. Required to route the reply correctly.`),
	status: z.enum(["completed", "clarification", "deferred", "needs_human"]).describe(`The outcome of your work.`),
	response: z.string().optional().describe(`Your full response to the request. Required when status is completed.`),
	question: z
		.string()
		.optional()
		.describe(`The specific question you need answered. Required when status is clarification.`),
	reason: z.string().optional().describe(`Why you are deferred or need a human. Required for those statuses.`),
	estimated_minutes: z.number().optional().describe(`Estimated minutes until you can handle this. For deferred.`),
	what_to_decide: z
		.string()
		.optional()
		.describe(`The specific decision or approval a human must make. Required for needs_human.`),
});
type ChannelReplyArgs = z.infer<typeof ChannelReplySchema>;

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
			inputSchema: ChannelReplySchema.shape as any,
		},
		async ({ session_id, status, ...rest }: ChannelReplyArgs) => {
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
