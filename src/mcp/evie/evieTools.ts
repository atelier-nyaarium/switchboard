import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EvieToolCallResult, EvieToolSchema } from "../../arbiter/evie/evieClient.js";
import { routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Functions & Helpers

/**
 * Register evie's action registry tools as MCP tools on the host.
 * Called when the evie client receives the tool_registry message.
 * Tools are prefixed with "evie_" to avoid name collisions.
 */
export function registerEvieTools(mcpServer: McpServer, tools: EvieToolSchema[]): void {
	for (const tool of tools) {
		const mcpName = `evie_${tool.name.replace(/-/g, "_")}`;

		// Build a Zod schema from the JSON Schema properties for MCP SDK compatibility.
		// Type-aware mapping prevents the model from sending numbers for string fields
		// (which causes precision loss on large Discord IDs).
		const properties = (tool.parameters.properties ?? {}) as Record<
			string,
			{ type?: string; description?: string; items?: { type?: string } }
		>;
		const shape: Record<string, z.ZodTypeAny> = {};
		for (const [key, prop] of Object.entries(properties)) {
			const desc = prop.description ?? "";
			switch (prop.type) {
				case "string":
					shape[key] = z.string().optional().describe(desc);
					break;
				case "number":
				case "integer":
					shape[key] = z.number().optional().describe(desc);
					break;
				case "boolean":
					shape[key] = z.boolean().optional().describe(desc);
					break;
				case "array":
					shape[key] = z.array(z.unknown()).optional().describe(desc);
					break;
				default:
					shape[key] = z.unknown().optional().describe(desc);
					break;
			}
		}
		const zodSchema = Object.keys(shape).length > 0 ? z.object(shape) : z.object({});

		mcpServer.registerTool(
			mcpName,
			{
				title: `Evie: ${tool.title}`,
				description: `[evie-bot] ${tool.description}`,
				// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
				inputSchema: zodSchema as any,
			},
			async (args: Record<string, unknown>) => {
				try {
					const response = (await routerPost("/evie/tool-call", {
						action: tool.name,
						params: args,
					})) as EvieToolCallResult;

					if (response.error) {
						return {
							content: [
								{ type: "text" as const, text: JSON.stringify({ error: response.error }, null, 2) },
							],
							isError: true,
						};
					}

					const resultText =
						typeof response.result === "string"
							? response.result
							: JSON.stringify(response.result, null, 2);

					return {
						content: [{ type: "text" as const, text: resultText }],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ error: (error as Error).message }, null, 2),
							},
						],
						isError: true,
					};
				}
			},
		);
	}

	console.error(`[evie-tools] registered ${tools.length} tools from evie-bot`);
}
