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
