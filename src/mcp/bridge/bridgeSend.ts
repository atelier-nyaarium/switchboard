import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResponsePayload } from "../../shared/types.js";
import { bridgeProjectName, routerPost } from "./helpers.js";

////////////////////////////////
//  Schemas

const BridgeSendSchema = z.object({
	to: z.string().describe(`Target team name. Use bridge_discover to find available teams.`),
	type: z.enum(["feature", "bugfix", "question"]).describe(`The type of request you are making.`),
	effort: z
		.enum(["simple", "standard", "complex"])
		.describe(`How much effort it should take to understand and handle this request.`),
	body: z
		.string()
		.describe(
			`Full Markdown formatted details of the request. Provide a detailed description and any context that would be helpful to the other team.`,
		),
	session_id: z
		.string()
		.optional()
		.describe(
			`Conversation session ID. Must be provided to continue the same conversation thread. Omit to start a new conversation thread.`,
		),
});
type BridgeSendArgs = z.infer<typeof BridgeSendSchema>;

////////////////////////////////
//  Interfaces & Types

type SendResult = ResponsePayload & { error?: string; available?: string[] };

////////////////////////////////
//  Functions & Helpers

export function registerBridgeSend(mcpServer: McpServer): void {
	mcpServer.tool(
		"bridge_send",
		`Send a request to another team and wait for their response. Blocks until they respond.`,
		BridgeSendSchema.shape,
		async ({ to, type, effort, body, session_id }: BridgeSendArgs) => {
			try {
				const result = (await routerPost("/send", {
					from: bridgeProjectName(),
					to,
					type,
					effort,
					body,
					session_id: session_id || null,
				})) as SendResult;

				if (result.error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Bridge error: ${result.error}${result.available ? `\nAvailable: ${result.available.join(", ")}` : ""}`,
							},
						],
						isError: true,
					};
				}

				const parts = [`Response from ${to}:`, `Status: ${result.status}`];

				if (result.status === "completed") {
					if (result.response) parts.push(`\n${result.response}`);
				} else if (result.status === "clarification") {
					parts.push(`Question: ${result.question}`);
					parts.push(`\nTo answer, use bridge_send with session_id: "${result.session_id}"`);
				} else if (result.status === "deferred") {
					parts.push(`Reason: ${result.reason}`);
					if (result.estimated_minutes) parts.push(`Estimated wait: ${result.estimated_minutes} minutes`);
					parts.push(`\nYou can use bridge_wait to wait, then retry.`);
				} else if (result.status === "needs_human") {
					parts.push(`Reason: ${result.reason}`);
					if (result.what_to_decide) parts.push(`Decision needed: ${result.what_to_decide}`);
					parts.push(`\nThe other team needs their human. Inform yours.`);
				} else if (result.status === "error") {
					parts.push(`Error: ${result.reason ?? "Unknown error"}`);
				} else if (result.status === "timeout") {
					parts.push(result.message || `No response in time.`);
				}

				if (result.session_id) parts.push(`\n[session_id: ${result.session_id}]`);

				return { content: [{ type: "text" as const, text: parts.join("\n") }] };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to send: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
