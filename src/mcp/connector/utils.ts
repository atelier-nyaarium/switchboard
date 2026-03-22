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
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const emptySchema: any = z.object({});
	mcpServer.registerTool(
		name,
		{
			title: name,
			description,
			inputSchema: emptySchema,
		},
		async () => textResult(handler()),
	);
}
