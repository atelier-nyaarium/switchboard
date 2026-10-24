// Guarded assistant send tools.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ASSISTANT_CROSSTALK_TOOLS } from "../../shared/assistant-session.js";
import {
	ASSISTANT_SEND_ROUTES,
	type AssistantSendAnswer,
	AssistantSendAnswerSchema,
	AssistantSendWithdrawAnswerSchema,
	SEND_ROUTE_WAIT_CAP_MS,
} from "../../shared/schemasAssistantSend.js";
import { oneLine } from "../../shared/system-reminder.js";
import type { ChannelFile } from "../../shared/types.js";
import { bridgeConversationId, RouterHttpError, routerPost } from "../bridge/helpers.js";
import { toolError } from "../bridge/replyTool.js";

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (body: string): ToolText => ({ content: [{ type: "text" as const, text: body }] });

/** Missing guard refuses sends. */
const UNGUARDED = "This Gateway does not guard the assistant's sends, so nothing was sent. It needs updating.";

export function guardedAnswerText(answer: AssistantSendAnswer): ToolText {
	switch (answer.outcome) {
		case "sent": {
			const how = answer.guard === "approved" ? "approved by the owner" : "sent without asking";
			return text(`Sent to ${answer.target}, ${how}.\n\n[session_id: ${answer.sessionId}]`);
		}
		case "pending":
			return text(
				`
Waiting on the owner's approval.

Continue with \`${ASSISTANT_CROSSTALK_TOOLS.collect}\` and request_id "${answer.requestId}", or give it up with \`${ASSISTANT_CROSSTALK_TOOLS.withdraw}\`.
				`.trim(),
			);
		case "denied":
			return toolError(
				answer.note
					? `The owner denied this send. Their note: ${oneLine(answer.note)}`
					: "The owner denied this send.",
			);
		case "expired":
			return toolError("The owner did not answer in time. Nothing was sent.");
		case "withdrawn":
			return toolError("Withdrawn. Nothing was sent.");
		case "failed":
			return toolError(`Not sent: ${oneLine(answer.reason)}`);
	}
}

/** Plain 404: no guard. */
function failureText(error: unknown, lead = "Not sent"): ToolText {
	if (error instanceof RouterHttpError && error.status === 404 && /Not Found$/.test(error.message)) {
		return toolError(UNGUARDED);
	}
	return toolError(`${lead}: ${error instanceof Error ? error.message : String(error)}`);
}

async function answered(path: string, body: Record<string, unknown>, lead?: string): Promise<ToolText> {
	try {
		return guardedAnswerText(AssistantSendAnswerSchema.parse(await routerPost(path, body)));
	} catch (error) {
		return failureText(error, lead);
	}
}

/** Forward intent only. */
export async function sendGuarded(args: {
	to: string;
	body: string;
	displayLabel?: string;
	disposition?: string;
	files: ChannelFile[];
}): Promise<ToolText> {
	return answered(ASSISTANT_SEND_ROUTES.send, {
		to: args.to,
		body: args.body,
		fromConversationId: bridgeConversationId(),
		...(args.displayLabel ? { displayLabel: args.displayLabel } : {}),
		...(args.disposition ? { disposition: args.disposition } : {}),
		...(args.files.length > 0 ? { files: args.files } : {}),
		waitMs: SEND_ROUTE_WAIT_CAP_MS,
	});
}

const requestId = z.string().min(1).max(128).describe(`The request_id a pending send answered.`);

export function registerAssistantSendTools(mcpServer: McpServer): void {
	mcpServer.registerTool(
		ASSISTANT_CROSSTALK_TOOLS.collect,
		{
			title: "Crosstalk Collect",
			description: `
# Crosstalk Collect

Wait for the owner's answer to a pending send, up to 230 seconds. Answers as \`${ASSISTANT_CROSSTALK_TOOLS.send}\` does.
			`.trim(),
			inputSchema: { request_id: requestId },
		},
		async ({ request_id }: { request_id: string }) =>
			answered(
				ASSISTANT_SEND_ROUTES.collect,
				{ requestId: request_id, waitMs: SEND_ROUTE_WAIT_CAP_MS },
				"Could not collect",
			),
	);

	mcpServer.registerTool(
		ASSISTANT_CROSSTALK_TOOLS.withdraw,
		{
			title: "Crosstalk Withdraw",
			description: `
# Crosstalk Withdraw

Give up a pending send before the owner answers. Nothing is sent.
			`.trim(),
			inputSchema: { request_id: requestId },
		},
		async ({ request_id }: { request_id: string }) => {
			try {
				const { withdrawn } = AssistantSendWithdrawAnswerSchema.parse(
					await routerPost(ASSISTANT_SEND_ROUTES.withdraw, { requestId: request_id }, { retries: 0 }),
				);
				return withdrawn
					? text("Withdrawn. Nothing was sent.")
					: toolError("Nothing to withdraw: the owner already answered, or the request is gone.");
			} catch (error) {
				return failureText(error);
			}
		},
	);
}
