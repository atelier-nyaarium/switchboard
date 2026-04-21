import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridgeProjectName, routerPost } from "../bridge/helpers.js";

////////////////////////////////
//  Schemas

const RespondToHumanSchema = z.object({
	session_id: z.string().describe(`Session id from the incoming channel_push.`),
	parts: z.array(z.string()).min(1).describe(`Message parts. Each string is sent as its own Discord message.`),
});
type RespondToHumanArgs = z.infer<typeof RespondToHumanSchema>;

const TransferHumanToSchema = z.object({
	session_id: z.string().describe(`Session id of the current conversation with the human.`),
	team: z.string().describe(`Team to transfer the line to. Use "host" for the host orchestrator.`),
	brief: z.string().min(1).describe(`Handoff brief pushed to the new holder as the first channel message.`),
});
type TransferHumanToArgs = z.infer<typeof TransferHumanToSchema>;

////////////////////////////////
//  Functions & Helpers

const RESPOND_DESCRIPTION = `
Reply to the human in the Discord channel the session is pinned to. Call multiple times to send multiple messages.

Only the current holder of the channel may call this. If the channel has no holder, calling this claims it for your team.

If you are not the holder, ask the current holder via crosstalk_send with a message like "Can I have the phone for session <id>?" and let them call transfer_human_to.
`.trim();

const TRANSFER_DESCRIPTION = `
Transfer the Discord conversation to another team. Only the current holder may call this.

Arbiter will:
  1. Wake the target team if offline (rejects if wake fails).
  2. Post a system message "Connected to <team> agent" to the human.
  3. Flip the pin to the new team.
  4. Push your brief to the new team as a channel message.

Use "host" as the team to return the line to the host orchestrator.
`.trim();

export function registerHumanTools(mcpServer: McpServer): void {
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const respondSchema: any = RespondToHumanSchema;
	// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
	const transferSchema: any = TransferHumanToSchema;

	mcpServer.registerTool(
		"respond_to_human",
		{
			title: "Respond to Human",
			description: RESPOND_DESCRIPTION,
			inputSchema: respondSchema,
		},
		async (args: RespondToHumanArgs) => {
			try {
				const from = bridgeProjectName();
				const result = (await routerPost("/human/respond", {
					from,
					session_id: args.session_id,
					parts: args.parts,
				})) as Record<string, unknown>;
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: String(result.error) }],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Sent ${args.parts.length} message part(s) to the human.`,
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `respond_to_human failed: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);

	mcpServer.registerTool(
		"transfer_human_to",
		{
			title: "Transfer Human To",
			description: TRANSFER_DESCRIPTION,
			inputSchema: transferSchema,
		},
		async (args: TransferHumanToArgs) => {
			try {
				const from = bridgeProjectName();
				const result = (await routerPost("/human/transfer", {
					from,
					session_id: args.session_id,
					team: args.team,
					brief: args.brief,
				})) as Record<string, unknown>;
				if (result.error) {
					return {
						content: [{ type: "text" as const, text: String(result.error) }],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Line transferred to "${args.team}".`,
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `transfer_human_to failed: ${(err as Error).message}` }],
					isError: true,
				};
			}
		},
	);
}
