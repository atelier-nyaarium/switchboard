import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { routerPost } from "../bridge/helpers.js";
import { assertNotContainer } from "./helpers.js";

////////////////////////////////
//  Schemas

const DiscordReplySchema = z.object({
	parts: z
		.array(z.string())
		.describe(`Message parts to send as Discord DMs. Each part must be under 2000 characters.`),
	retryCount: z
		.number()
		.optional()
		.default(0)
		.describe(
			`Retry count for message splitting. Increment on each retry if the previous attempt failed validation.`,
		),
});
type DiscordReplyArgs = z.input<typeof DiscordReplySchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const replySchema: any = DiscordReplySchema;

////////////////////////////////
//  Functions & Helpers

const description = `
Send a message to the user via Discord DM.
Provide the message as an array of parts, each under 2000 characters.
If the message is short enough, use a single-element array.
If validation fails, the response includes splitting guidelines and a suggested part count. Retry with the message split into that many parts.
Send the message verbatim unless the user explicitly asked for a summary.
`.trim();

export function registerDiscordReply(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"discord_reply",
		{
			title: "Discord Reply",
			description,
			inputSchema: replySchema,
		},
		async (args: DiscordReplyArgs) => {
			try {
				assertNotContainer();

				const parts = args.parts;
				const retryCount = args.retryCount ?? 0;

				const result = (await routerPost("/discord/reply", { parts, retryCount })) as Record<string, unknown>;

				return {
					content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
					isError: !result.success,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ errors: [{ message: (error as Error).message }] }, null, 2),
						},
					],
					isError: true,
				};
			}
		},
	);
}
