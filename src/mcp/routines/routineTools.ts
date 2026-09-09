import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionRoutineAnswerSchema } from "../../shared/schemasRoutine.js";
import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import { routerPost } from "../bridge/helpers.js";

const COMMAND = SESSION_COMMANDS.sessionRoutine;

const DESCRIPTION = `
# Get Session Routine

Read the instructions for a routine run in this session.

The nudge names an occurrence id. Pass it here.

The answer is the wording as it stood when the run was issued, so a runbook edited since does not
change what was asked of you. Read it again after a compaction rather than working from memory.
`.trim();

const InputSchema = {
	occurrenceId: z.string().min(1).max(64).describe(`Occurrence id from the nudge.`),
};

/** What each outcome means, said rather than left to a bare kind. */
function textOf(answer: z.infer<typeof SessionRoutineAnswerSchema>): string {
	switch (answer.kind) {
		case "instructions":
			return `# ${answer.routineName}\n\n${answer.text}`;
		case "no_routine":
			return "No routine runs in this session.";
		case "unknown_occurrence":
			return "This session holds no run under that id.";
		case "wrong_session":
			return "That run belongs to another session.";
		case "unauthenticated":
			return "This session is not bound to the Gateway.";
	}
}

export function registerRoutineTools(mcpServer: McpServer): void {
	mcpServer.registerTool(
		COMMAND.tool,
		{ title: `Get Session Routine`, description: DESCRIPTION, inputSchema: InputSchema },
		async (args: { occurrenceId: string }) => {
			try {
				const answer = COMMAND.answer.parse(
					await routerPost(COMMAND.path, { occurrenceId: args.occurrenceId }, { retries: 0 }),
				) as z.infer<typeof SessionRoutineAnswerSchema>;
				return {
					content: [{ type: "text" as const, text: textOf(answer) }],
					...(answer.kind === "instructions" ? {} : { isError: true }),
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
