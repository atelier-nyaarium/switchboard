import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { routerPost } from "./helpers.js";

////////////////////////////////
//  Interfaces & Types

interface ReplyArgsBase {
	session_id: string;
	status?: string;
	replyAsString?: string;
	replyAsJson?: string;
}

////////////////////////////////
//  Functions & Helpers

export function registerReplyTool<S extends z.ZodTypeAny>(
	mcpServer: McpServer,
	toolName: string,
	title: string,
	description: string,
	logPrefix: string,
	schema: S,
): void {
	mcpServer.registerTool(
		toolName,
		{
			title,
			description,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: schema as any,
		},
		async (args: unknown) => {
			try {
				const { session_id, status, replyAsString, replyAsJson, ...rest } = args as ReplyArgsBase &
					Record<string, unknown>;
				const payload: Record<string, unknown> = { session_id, ...rest };
				if (status !== undefined) payload.status = status;

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
				const suffix = status ? ` (${status})` : "";
				console.error(`[${logPrefix}] ${toolName} sent${suffix} [${session_id}]`);
				return { content: [{ type: "text" as const, text: `Reply sent${suffix}.` }] };
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
