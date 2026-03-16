import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

////////////////////////////////
//  Schemas

const BridgeWaitSchema = z.object({
	seconds: z.number().min(1).max(1800),
});
type BridgeWaitArgs = z.infer<typeof BridgeWaitSchema>;

////////////////////////////////
//  Functions & Helpers

export function registerBridgeWait(mcpServer: McpServer): void {
	mcpServer.tool(
		"bridge_wait",
		`Wait N seconds before retrying. Use when another team asks you to wait.`,
		BridgeWaitSchema.shape,
		async ({ seconds }: BridgeWaitArgs) => {
			await new Promise((r) => setTimeout(r, seconds * 1000));
			return { content: [{ type: "text" as const, text: `Waited ${seconds}s. You can retry now.` }] };
		},
	);
}
