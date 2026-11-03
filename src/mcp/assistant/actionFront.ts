// The two doors to both registries.

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	ACTION_FRONT_ROUTES,
	ACTION_FRONT_TOOLS,
	ActionListAnswerSchema,
	type ActionListing,
	type ActionRef,
	type ActionRunResult,
	ActionRunResultSchema,
	actionRefOf,
} from "../../shared/schemasActionFront.js";
import { type ActionAnswer, ASSISTANT_ACTIONS } from "../../shared/schemasAssistantActions.js";
import { PHONE_CAPABILITIES } from "../../shared/schemasPhoneCapabilities.js";
import { ASSISTANT_COMMANDS } from "../../shared/session-commands.js";
import { oneLine } from "../../shared/system-reminder.js";
import { RouterHttpError, routerPost } from "../bridge/helpers.js";

const LIST = ACTION_FRONT_TOOLS.list;
const RUN = ACTION_FRONT_TOOLS.run;
const INBOX = ASSISTANT_COMMANDS.inbox.tool;
const STATUS_ID = "phone/status";
const NOT_RECORDED = "Your summary was not recorded.";
const NOT_SERVED = `This Gateway does not serve ${LIST} and ${RUN}; it needs updating.`;

/** Terminal watcher outcomes. */
const SETTLED = new Set(["done", "not_found"]);

/** Pre-dispatch refusals. */
const refusedOutright = (status: number) => status < 500 || status === 503;

export type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: true };

export const text = (body: string, failed = false): ToolText => ({
	content: [{ type: "text" as const, text: body }],
	...(failed ? { isError: true as const } : {}),
});

const SESSION_TEXT: Record<"not_assistant" | "unauthenticated", string> = {
	not_assistant: "This session is not the assistant.",
	unauthenticated: "This session is not bound to the Gateway.",
};

function availabilityText(action: ActionListing): string {
	if (action.family === "watcher") return "";
	if (action.family === "gateway" || action.where === "gateway") return "; runs on the Gateway";
	if (action.available === null) return `; availability unknown, ${STATUS_ID} learns it`;
	return action.available
		? "; available on the holding phone"
		: `; unavailable on the holding phone (${action.reason ?? "unknown"})`;
}

export function listingText(actions: ActionListing[]): string {
	return actions
		.map((action) =>
			[
				`## ${action.id}`,
				`${action.label}; ${action.kind}${availabilityText(action)}`,
				"",
				action.usage,
				"",
				"Parameters:",
				"```json",
				JSON.stringify(action.params),
				"```",
			].join("\n"),
		)
		.join("\n\n");
}

export function watcherText(result: ActionRunResult, answer: ActionAnswer | null, summarized: boolean): string {
	if (result.kind === "not_assistant" || result.kind === "unauthenticated") return SESSION_TEXT[result.kind];
	const lost = summarized ? ["", NOT_RECORDED] : [];
	if (result.kind === "refused") return [`Refused: ${oneLine(result.reason)}`, ...lost].join("\n");
	if (result.kind === "unavailable") return [`Unavailable: ${result.reason}`, ...lost].join("\n");
	if (!answer) return "The Gateway answered something this plugin cannot read.";
	const lines = answer.threads.map(
		(thread) => `- ${thread.threadId}${thread.title ? ` ${oneLine(thread.title)}` : ""}: ${thread.outcome}`,
	);
	if (answer.note !== undefined) lines.push("", oneLine(answer.note));
	if (!result.recorded) return [...lines, "", summarized ? NOT_RECORDED : "Not recorded."].join("\n");
	lines.push("", summarized ? "Recorded with your summary; send any unfinished ids again without it." : "Recorded.");
	return lines.join("\n");
}

export function phoneText(result: ActionRunResult, answer: unknown): string {
	if (result.kind === "not_assistant" || result.kind === "unauthenticated") return SESSION_TEXT[result.kind];
	if (result.kind === "refused") return `Refused: ${oneLine(result.reason)}`;
	if (result.kind === "unavailable") {
		const needs = result.needs?.length ? `; needs ${result.needs.join(", ")}` : "";
		return `Unavailable: ${result.reason}${needs}${result.detail ? `; ${result.detail}` : ""}`;
	}
	if (answer === undefined) return "The Gateway returned an answer this tool cannot read.";
	return JSON.stringify(answer);
}

function render(ref: ActionRef | null, result: ActionRunResult, params: Record<string, unknown>): ToolText {
	if (ref?.family === "watcher") {
		const answer =
			result.kind === "ok" ? (ASSISTANT_ACTIONS[ref.key].answer.safeParse(result.answer).data ?? null) : null;
		const failed =
			result.kind !== "ok" ||
			!result.recorded ||
			!answer ||
			answer.threads.some((thread) => !SETTLED.has(thread.outcome));
		return text(watcherText(result, answer, typeof params.summary === "string"), failed);
	}
	// An unknown key renders the answer as sent.
	const answer =
		result.kind !== "ok"
			? undefined
			: ref
				? PHONE_CAPABILITIES[ref.key].answer.safeParse(result.answer).data
				: result.answer;
	return text(phoneText(result, answer), result.kind !== "ok" || answer === undefined);
}

function unreachable(ref: ActionRef | null, error: unknown): ToolText {
	const status = error instanceof RouterHttpError ? error.status : null;
	if (status === 404) return text(NOT_SERVED, true);
	if (status === 400) return text(`Not an action this Gateway knows; read \`${LIST}\`.`, true);
	const why =
		ref?.family === "watcher" && status !== null && refusedOutright(status)
			? "The Gateway did not run it"
			: `Could not reach the Gateway${status === null ? "" : ` (HTTP ${status})`}; it may still have run, so read \`${INBOX}\` or ${STATUS_ID} before sending it again`;
	return text(`${why}: ${(error as Error).message}`, true);
}

export function registerActionFront(mcpServer: McpServer): void {
	mcpServer.registerTool(
		LIST,
		{
			title: "List actions",
			description: `
# List actions

Every action \`${RUN}\` can run: its id, kind, what it needs, whether the holding phone serves it, and its parameter schema.

Read it before a \`${RUN}\`. \`${STATUS_ID}\` refreshes what the holding phone serves.
			`.trim(),
			inputSchema: {},
		},
		async () => {
			try {
				const answer = ActionListAnswerSchema.parse(
					await routerPost(ACTION_FRONT_ROUTES.list, {}, { retries: 2 }),
				);
				if (answer.kind !== "listed") return text(SESSION_TEXT[answer.kind], true);
				return text(listingText(answer.actions));
			} catch (error) {
				if (error instanceof RouterHttpError && error.status === 404) return text(NOT_SERVED, true);
				return text(`Could not list actions: ${(error as Error).message}`, true);
			}
		},
	);

	mcpServer.registerTool(
		RUN,
		{
			title: "Run action",
			description: `
# Run action

Run one action by \`id\` from \`${LIST}\`, with \`params\` in its schema.

A \`phone/\` id runs on the holding phone; a \`gateway/\` or \`watcher/\` id runs on the Gateway. Only this tool's transport retries share a call.
			`.trim(),
			inputSchema: {
				id: z.string().describe(`An id from \`${LIST}\`, such as \`${STATUS_ID}\`.`),
				params: z.record(z.string(), z.unknown()).default({}),
			},
		},
		async ({ id, params }) => {
			const ref = actionRefOf(id);
			let result: ActionRunResult;
			try {
				result = ActionRunResultSchema.parse(
					await routerPost(ACTION_FRONT_ROUTES.run, { id, callId: randomUUID(), params }, { retries: 2 }),
				);
			} catch (error) {
				return unreachable(ref, error);
			}
			return render(ref, result, params);
		},
	);
}
