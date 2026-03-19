import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

////////////////////////////////
//  Functions & Helpers

export function textResult(text: string, isError?: boolean) {
	return {
		content: [{ type: "text" as const, text }],
		...(isError && { isError: true as const }),
	};
}

export function registerStubTool(mcpServer: McpServer, name: string, description: string, handler: () => string): void {
	mcpServer.registerTool(
		name,
		{
			title: name,
			description,
			// biome-ignore lint/suspicious/noExplicitAny: zod v4 / MCP SDK type compat
			inputSchema: z.object({}).shape as any,
		},
		async () => textResult(handler()),
	);
}
