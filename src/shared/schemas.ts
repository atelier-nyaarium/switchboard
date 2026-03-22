import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { routerPost } from "../mcp/bridge/helpers.js";

export const BridgeReplySchema = z.object({
	session_id: z.string().describe(`The session_id for this request. Required to route the reply correctly.`),
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

export type BridgeReplyArgs = z.infer<typeof BridgeReplySchema>;

export function registerReplyTool(
	mcpServer: McpServer,
	toolName: string,
	title: string,
	description: string,
	logPrefix: string,
): void {
	mcpServer.registerTool(
		toolName,
		{
			title,
			description,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: BridgeReplySchema as any,
		},
		async ({ session_id, status, ...rest }: BridgeReplyArgs) => {
			try {
				await routerPost("/respond", { session_id, status, ...rest });
				console.error(`[${logPrefix}] ${toolName} sent: ${status} [${session_id}]`);
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
