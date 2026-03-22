import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
			inputSchema: {},
		},
		async () => textResult(handler()),
	);
}
