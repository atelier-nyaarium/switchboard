import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNotContainer } from "./helpers.js";

////////////////////////////////
//  Schemas

const SessionPeekSchema = z.object({
	team: z.string().describe(`Team name (e.g. "evie-bot"). Resolves to container "{team}_devcontainer-dev-1".`),
	lines: z.number().optional().default(50).describe(`Number of scrollback lines to capture. Defaults to 50.`),
});
type SessionPeekArgs = z.infer<typeof SessionPeekSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const peekSchema: any = SessionPeekSchema;

////////////////////////////////
//  Functions & Helpers

const description = `
Capture the visible screen of a team's Claude Code session (tmux pane 0).
Use this to check if the session is idle, has Remote Control active, or is stuck on a confirmation dialog.
Always use this before and after session_send to verify session state.
`.trim();

export function registerSessionPeek(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"session_peek",
		{
			title: "Session Peek",
			description,
			inputSchema: peekSchema,
		},
		async (args: SessionPeekArgs) => {
			try {
				assertNotContainer();

				const container = `${args.team}_devcontainer-dev-1`;
				const lines = args.lines ?? 50;

				const output = execSync(
					`docker exec -u vscode "${container}" tmux capture-pane -t claude.0 -p -S -${lines}`,
					{ encoding: "utf-8", timeout: 10_000 },
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ team: args.team, container, screen: output }, null, 2),
						},
					],
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
