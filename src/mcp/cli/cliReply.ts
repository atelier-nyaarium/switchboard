import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BridgeReplyArgs, BridgeReplySchema } from "../../shared/schemas.js";
import { routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

/**
 * Register the crosstalk_reply tool for CLI (run-and-quit) agents.
 * CLI agents call this to reply to incoming bridge requests.
 */
export function registerCliReply(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"crosstalk_reply",
		{
			title: "Crosstalk Reply",
			description: `Reply to an incoming bridge request. Call this once when you are done handling the request.`,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: BridgeReplySchema as any,
		},
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
