import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BridgeReplyArgs, BridgeReplySchema } from "../../shared/schemas.js";
import { routerPost } from "./helpers.js";

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
		async ({ session_id, status, replyAsString, replyAsJson, ...rest }: BridgeReplyArgs) => {
			try {
				const payload: Record<string, unknown> = { session_id, status, ...rest };

				if (replyAsJson) {
					try {
						payload.replyAsJson = JSON.parse(replyAsJson);
					} catch {
						return {
							content: [{ type: "text" as const, text: "replyAsJson must be a valid JSON string." }],
							isError: true,
						};
					}
				} else if (replyAsString !== undefined) {
					payload.response = replyAsString;
				}

				await routerPost("/respond", payload);
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
