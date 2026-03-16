import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bridgeProjectName, routerGet } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

export function registerBridgeDiscover(mcpServer: McpServer): void {
	mcpServer.tool("bridge_discover", `List all active teams on the bridge network.`, {}, async () => {
		try {
			const teams = (await routerGet("/teams")) as Array<{ team: string; queue_depth: number }>;
			const others = teams.filter((t) => t.team !== bridgeProjectName());

			if (others.length === 0) {
				return { content: [{ type: "text" as const, text: `No other teams are currently online.` }] };
			}

			const lines = others.map((t) => {
				const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "available";
				return `- ${t.team}: ${status}`;
			});

			return {
				content: [{ type: "text" as const, text: `Teams on the bridge:\n${lines.join("\n")}` }],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: `Failed to reach router: ${message}` }],
				isError: true,
			};
		}
	});
}
