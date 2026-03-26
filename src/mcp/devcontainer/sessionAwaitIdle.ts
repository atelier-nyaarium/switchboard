import { execSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertNotContainer } from "./helpers.js";

////////////////////////////////
//  Schemas

const SessionAwaitIdleSchema = z.object({
	team: z.string().describe(`Team name (e.g. "evie-bot"). Resolves to container "{team}_devcontainer-dev-1".`),
	timeout_ms: z
		.number()
		.optional()
		.default(300_000)
		.describe(`Max time to wait in milliseconds. Defaults to 300000 (5 minutes).`),
	poll_interval_ms: z
		.number()
		.optional()
		.default(5_000)
		.describe(`How often to check the session in milliseconds. Defaults to 5000 (5 seconds).`),
});
type SessionAwaitIdleArgs = z.infer<typeof SessionAwaitIdleSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const awaitIdleSchema: any = SessionAwaitIdleSchema;

////////////////////////////////
//  Functions & Helpers

const description = `
Wait for a team's Claude Code session to become idle or show an edit confirmation prompt.
Polls the session screen until one of these states is detected:
- "idle" — session shows the ✻ Idle indicator
- "edit_prompt" — session shows "Do you want to make this edit"
- "timeout" — neither state detected within the timeout period (returns last screen capture)
`.trim();

function detectState(screen: string): "idle" | "edit_prompt" | null {
	if (screen.includes("Do you want to make this edit")) {
		return "edit_prompt";
	}
	if (/✻\s*Idle/.test(screen)) {
		return "idle";
	}
	return null;
}

export function registerSessionAwaitIdle(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"session_await_idle",
		{
			title: "Session Await Idle",
			description,
			inputSchema: awaitIdleSchema,
		},
		async (args: SessionAwaitIdleArgs) => {
			try {
				assertNotContainer();

				const container = `${args.team}_devcontainer-dev-1`;
				const timeoutMs = args.timeout_ms ?? 300_000;
				const pollMs = args.poll_interval_ms ?? 5_000;
				const deadline = Date.now() + timeoutMs;

				let lastScreen = "";

				while (Date.now() < deadline) {
					try {
						lastScreen = execSync(
							`docker exec -u vscode "${container}" tmux capture-pane -t claude.0 -p -S -50`,
							{ encoding: "utf-8", timeout: 10_000 },
						);
					} catch {
						// Container or tmux not ready, keep polling
					}

					const state = detectState(lastScreen);
					if (state) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({ team: args.team, state, screen: lastScreen }, null, 2),
								},
							],
						};
					}

					await new Promise((resolve) => setTimeout(resolve, pollMs));
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ team: args.team, state: "timeout", screen: lastScreen }, null, 2),
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
