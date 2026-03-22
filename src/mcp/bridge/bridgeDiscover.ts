import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bridgeProjectName, routerGet } from "./helpers.js";

////////////////////////////////
//  Functions & Helpers

export function registerBridgeDiscover(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"crosstalk_discover",
		{
			title: "Crosstalk Discover",
			description: `List all teams on the bridge network (online and available).`,
			inputSchema: {},
		},
		async () => {
			try {
				const teams = (await routerGet("/teams")) as Array<{
					team: string;
					status: string;
					queue_depth: number;
				}>;
				const others = teams.filter((t) => t.team !== bridgeProjectName());

				if (others.length === 0) {
					return { content: [{ type: "text" as const, text: `No other teams found.` }] };
				}

				const lines = others.map((t) => {
					if (t.status === "available") return `- ${t.team}: available (wake on demand)`;
					const status = t.queue_depth > 0 ? `busy (${t.queue_depth} in queue)` : "online";
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
		},
	);
}
