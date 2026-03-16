import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { routerPost } from "./helpers.js";

////////////////////////////////
//  Schemas

const BridgeReplySchema = z.object({
	session_id: z
		.string()
		.describe(`The session_id from the incoming request header. Required to route the reply correctly.`),
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
type BridgeReplyArgs = z.infer<typeof BridgeReplySchema>;

////////////////////////////////
//  Functions & Helpers

export function registerBridgeReply(mcpServer: McpServer): void {
	mcpServer.tool(
		"crosstalk_reply",
		`Reply to an incoming bridge request. Call this once when you are done handling the request.`,
		BridgeReplySchema.shape,
		async ({ session_id, status, ...rest }: BridgeReplyArgs) => {
			try {
				await routerPost("/respond", { session_id, status, ...rest });
				console.error(`[bridge] crosstalk_reply sent: ${status} [${session_id}]`);
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
