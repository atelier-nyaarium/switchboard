import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNotContainer } from "./helpers.js";

////////////////////////////////
//  Schemas

const HostSessionPeekSchema = z.object({
	lines: z.number().optional().default(50).describe(`Number of scrollback lines to capture. Defaults to 50.`),
});
type HostSessionPeekArgs = z.infer<typeof HostSessionPeekSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const peekSchema: any = HostSessionPeekSchema;

////////////////////////////////
//  Functions & Helpers

const TMUX_TARGET = "claude.0";

const description = `
Capture the visible screen of the host Claude Code session (tmux pane 0).
Use this to check if the host session is idle, has Remote Control active, or is stuck on a confirmation dialog.
`.trim();

export function registerHostSessionPeek(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"host_session_peek",
		{
			title: "Host Session Peek",
			description,
			inputSchema: peekSchema,
		},
		async (args: HostSessionPeekArgs) => {
			try {
				assertNotContainer();

				const lines = args.lines ?? 50;

				const output = execSync(`tmux capture-pane -t ${TMUX_TARGET} -p -S -${lines}`, {
					encoding: "utf-8",
					timeout: 10_000,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ target: "host", screen: output }, null, 2),
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
