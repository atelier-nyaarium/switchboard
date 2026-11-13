import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionCutSummaryAnswer } from "../../shared/schemasSessionCut.js";
import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import { routerPost } from "../bridge/helpers.js";

const COMMAND = SESSION_COMMANDS.sessionCutSummary;

const DESCRIPTION = `
Send the summary a compact request asked this session to write.

Pass the \`cutId\` from the request. \`summary\` replaces everything before the message the request quotes. Cover:

- The goal, and what the owner asked for in their own words.
- Decisions made, with their reasons.
- The state of the work: done, in progress, left.
- Standing rules and preferences.
- Names the work needs: files, ids, commands.

Leave out the quoted message and everything after it.

Then end the turn: the session closes and resumes compacted.
`.trim();

/** What each outcome means, said rather than left to a bare kind. */
export function textOf(answer: SessionCutSummaryAnswer): string {
	switch (answer.kind) {
		case "taken":
			return "Summary taken. This session now closes and resumes compacted. End the turn here.";
		case "unknown_cut":
			return "No compact under that id waits on this session. Nothing was changed.";
		case "unauthenticated":
			return "This session is not bound to the Gateway.";
	}
}

export function registerCutTools(mcpServer: McpServer): void {
	mcpServer.registerTool(
		COMMAND.tool,
		{ title: `Submit Session Summary`, description: DESCRIPTION, inputSchema: COMMAND.request },
		async (args: { cutId: string; summary: string }) => {
			try {
				const answer = COMMAND.answer.parse(
					await routerPost(COMMAND.path, { cutId: args.cutId, summary: args.summary }, { retries: 0 }),
				) as SessionCutSummaryAnswer;
				return {
					content: [{ type: "text" as const, text: textOf(answer) }],
					...(answer.kind === "taken" ? {} : { isError: true }),
				};
			} catch (error) {
				return {
					content: [
						{ type: "text" as const, text: `Could not reach the Gateway: ${(error as Error).message}` },
					],
					isError: true,
				};
			}
		},
	);
}
