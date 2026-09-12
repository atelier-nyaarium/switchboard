import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { SessionReportAnswer, SessionRoutineAnswerSchema } from "../../shared/schemasRoutine.js";
import { SESSION_COMMANDS } from "../../shared/session-commands.js";
import { routerPost } from "../bridge/helpers.js";

const COMMAND = SESSION_COMMANDS.sessionRoutine;
const REPORT = SESSION_COMMANDS.sessionReport;

const DESCRIPTION = `
# Get Session Routine

Read the instructions for a routine run in this session.

The nudge names an occurrence id. Pass it here.

The answer is the wording as it stood when the run was issued, so a runbook edited since does not
change what was asked of you. Read it again after a compaction rather than working from memory.
`.trim();

const REPORT_DESCRIPTION = `
# Report Session Routine

File this run's own account of what it did.

Filing narrows the run's authority: the window its standing secrets live in pulls in to about half
an hour, instead of the twelve hours it would otherwise hold. Keep working after filing if there is
more to do. Filing again replaces the words and never widens the window back out.

Write what you did and what you left. This is what the owner reads later.
`.trim();

/** What each outcome means, said rather than left to a bare kind. */
export function reportTextOf(answer: SessionReportAnswer): string {
	switch (answer.kind) {
		case "filed":
			return `Report filed. Authority for this run now ends at ${new Date(answer.workUntil).toISOString()}.`;
		case "not_working":
			return "This run is already over, so there is no window left to narrow.";
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

/** What each outcome means, said rather than left to a bare kind. */
export function textOf(answer: z.infer<typeof SessionRoutineAnswerSchema>): string {
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
		{ title: `Get Session Routine`, description: DESCRIPTION, inputSchema: COMMAND.request },
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

	mcpServer.registerTool(
		REPORT.tool,
		{ title: `Report Session Routine`, description: REPORT_DESCRIPTION, inputSchema: REPORT.request },
		async (args: { occurrenceId: string; report: string }) => {
			try {
				const answer = REPORT.answer.parse(
					await routerPost(
						REPORT.path,
						{ occurrenceId: args.occurrenceId, report: args.report },
						{ retries: 0 },
					),
				) as SessionReportAnswer;
				return {
					content: [{ type: "text" as const, text: reportTextOf(answer) }],
					...(answer.kind === "filed" ? {} : { isError: true }),
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
