// Tool names match action keys.

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	type ActionAnswer,
	ASSISTANT_ACTION_KEYS,
	ASSISTANT_ACTION_PATH,
	ASSISTANT_ACTIONS,
	type AssistantActionResult,
	AssistantActionResultSchema,
} from "../../shared/schemasAssistantActions.js";
import { ASSISTANT_COMMANDS } from "../../shared/session-commands.js";
import { oneLine } from "../../shared/system-reminder.js";
import { RouterHttpError, routerPost } from "../bridge/helpers.js";

const NOT_RECORDED = "Your summary was not recorded.";

export function actionText(result: AssistantActionResult, answer: ActionAnswer | null, summarized: boolean): string {
	if (result.kind === "not_assistant") return "This session is not the assistant.";
	if (result.kind === "unauthenticated") return "This session is not bound to the Gateway.";
	const lost = summarized ? ["", NOT_RECORDED] : [];
	if (result.kind === "refused") return [`Refused: ${oneLine(result.reason)}`, ...lost].join("\n");
	if (!answer) return "The Gateway answered something this plugin cannot read.";
	const lines = answer.threads.map(
		(thread) => `- ${thread.threadId}${thread.title ? ` ${oneLine(thread.title)}` : ""}: ${thread.outcome}`,
	);
	if (answer.note !== undefined) lines.push("", oneLine(answer.note));
	if (!result.recorded) return [...lines, ...lost].join("\n");
	lines.push("", summarized ? "Recorded with your summary; send any unfinished ids again without it." : "Recorded.");
	return lines.join("\n");
}

/** Terminal outcomes. */
const SETTLED = new Set(["done", "not_found"]);

/** Pre-dispatch refusals. */
const refusedOutright = (status: number) => status < 500 || status === 503;

export function registerActionTools(mcpServer: McpServer): void {
	for (const key of ASSISTANT_ACTION_KEYS) {
		const declaration = ASSISTANT_ACTIONS[key];
		mcpServer.registerTool(
			key,
			{ title: declaration.label, description: declaration.usage, inputSchema: declaration.params },
			async (params: Record<string, unknown>) => {
				// Retries reuse this id.
				const callId = randomUUID();
				let result: AssistantActionResult;
				try {
					result = AssistantActionResultSchema.parse(
						await routerPost(ASSISTANT_ACTION_PATH, { action: key, callId, params }, { retries: 2 }),
					);
				} catch (error) {
					const status = error instanceof RouterHttpError ? error.status : null;
					const why =
						status === null || !refusedOutright(status)
							? `Could not reach the Gateway; it may still have run, so read \`${ASSISTANT_COMMANDS.inbox.tool}\` before sending it again`
							: `The Gateway did not run it${status === 404 ? "; this Gateway predates the action" : ""}`;
					return {
						content: [{ type: "text" as const, text: `${why}: ${(error as Error).message}` }],
						isError: true,
					};
				}
				const answer =
					result.kind === "ran" ? (declaration.answer.safeParse(result.answer).data ?? null) : null;
				const failed =
					result.kind !== "ran" || !answer || answer.threads.some((thread) => !SETTLED.has(thread.outcome));
				return {
					content: [
						{ type: "text" as const, text: actionText(result, answer, typeof params.summary === "string") },
					],
					...(failed ? { isError: true } : {}),
				};
			},
		);
	}
}
