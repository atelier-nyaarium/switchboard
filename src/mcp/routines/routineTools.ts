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

File this run's account of itself, and the routine's history amended with what you learned.

\`report\` is this run alone: what you did, what you left.

\`history\` is what the NEXT run of this routine is handed. You were given it and its
\`historyVersion\` with the instructions. Return it mostly as it stands, amended with what is worth
carrying: facts that will still be true next time, things you fixed, things you chose not to. Drop
what has gone stale. It is a running account, not a log, so keep it consolidated.

Filing narrows this run's authority: the window its standing secrets live in pulls in to about half
an hour, instead of the twelve hours it would otherwise hold. Keep working after filing if there is
more to do.

Answers you may get back:

- \`history_conflict\` means another run wrote history while you worked. The current text comes back
  with it. Fold your findings into that and file once more; the second filing lands.
- \`history_too_large\` means consolidate and file again.
`.trim();

/** What each outcome means, said rather than left to a bare kind. */
export function reportTextOf(answer: SessionReportAnswer): string {
	switch (answer.kind) {
		case "filed":
			return `Report filed. Authority for this run now ends at ${new Date(answer.workUntil).toISOString()}.`;
		case "history_conflict":
			return [
				"Another run of this routine wrote history while you worked, so yours was not taken.",
				"Below is what is held now. Fold your own findings into it and file once more; that one lands.",
				"",
				`historyVersion: ${answer.historyVersion}`,
				"",
				answer.history,
			].join("\n");
		case "history_too_large":
			return `That history is over ${answer.maxBytes} bytes. Consolidate it and file again.`;
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
			return answer.history
				? [
						`# ${answer.routineName}`,
						"",
						answer.text,
						"",
						`## What earlier runs left (historyVersion ${answer.historyVersion})`,
						"",
						answer.history,
					].join("\n")
				: `# ${answer.routineName}\n\n${answer.text}`;
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
		async (args: { occurrenceId: string; report: string; history: string; historyVersion: number }) => {
			try {
				const answer = REPORT.answer.parse(
					await routerPost(
						REPORT.path,
						{
							occurrenceId: args.occurrenceId,
							report: args.report,
							history: args.history,
							historyVersion: args.historyVersion,
						},
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
