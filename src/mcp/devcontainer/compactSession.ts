import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { neutralizeMarkup } from "../../shared/system-reminder.js";
import { selfSessionTarget, sendText } from "./tmuxCore.js";

////////////////////////////////
//  Constants

/** One line: a newline would submit early. */
const RECALL_FIRST = [
	"Write the summary so this session can carry on from it alone.",
	"Goal: what the owner wants, in their words.",
	"Owner instructions: quote every rule and preference verbatim, including those carried in an earlier summary.",
	"Keep exact: file paths, ids, commit hashes, commands, error messages, each channel session_id with who is on it, task board entry ids, agent ids, vault job ids, routine occurrence ids.",
	"Current state: what is done and verified, and what is done but unverified.",
	"Next steps, in order.",
	"Drop what a re-read or re-run recovers, keeping its path or command.",
	"If a team exists, keep its team_name, each teammate's name and agentType, its config and tasks paths, and in-flight task ids with owners.",
].join(" ");

////////////////////////////////
//  Schemas

const CompactSessionSchema = z
	.object({
		instructions: z
			.string()
			.min(1)
			// One argv element, so it is capped below ARG_MAX and a NUL would truncate the line.
			.max(16384)
			.refine((v) => !/[\r\n]/.test(v) && !v.includes("\u0000"), {
				message: `instructions must be a single line (no newlines or null bytes)`,
			})
			.optional()
			.describe(
				`
Extra compaction instructions, sent after the fixed recall-first ones. One plain-text line with no newlines.

Name what this session must not lose that the fixed ones would not catch.
`.trim(),
			),
	})
	.strict();
type CompactSessionArgs = z.infer<typeof CompactSessionSchema>;

// biome-ignore lint/suspicious/noExplicitAny: MCP SDK type compat
const compactSchema: any = CompactSessionSchema;

////////////////////////////////
//  Functions & Helpers

const description = `
# Compact Session

Send \`/compact\` to local tmux pane \`0\`, with fixed recall-first instructions and any extra ones.

## Idle session

\`/compact\` only works when the REPL prompt accepts input.

Before calling, schedule one-shot \`CronCreate\` for two minutes later with prompt \`Resume.\`, then stop the current turn.
`.trim();

export function registerCompactSession(mcpServer: McpServer): void {
	mcpServer.registerTool(
		"compact_session",
		{
			title: `Compact Session`,
			description,
			inputSchema: compactSchema,
		},
		async (args: CompactSessionArgs) => {
			try {
				// Outlives the compact.
				const extra = args.instructions === undefined ? "" : ` ${neutralizeMarkup(args.instructions)}`;
				const command = `/compact ${RECALL_FIRST}${extra}`;
				await sendText(selfSessionTarget(), command);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ instructions: args.instructions, command, sent: true }, null, 2),
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
