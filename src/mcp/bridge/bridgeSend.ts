import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SendRefusalSchema, sendRefusalText, startingText } from "../../shared/launch-notice.js";
import { REAL_NEWLINES_GUIDANCE } from "../../shared/schemas.js";
import { SESSION_HARNESSES } from "../../shared/session-harness.js";
import type { ChannelFile, ResponsePayload } from "../../shared/types.js";
import { sendGuarded } from "../assistant/sendTools.js";
import { dropReferenceArtifacts } from "../channel/channelFiles.js";
import { bridgeConversationId, bridgeProjectName, opLedgerRefusal, RouterHttpError, routerPost } from "./helpers.js";
import { literalEscapeHazard, literalEscapeReject, readReplyAttachments, toolError } from "./replyTool.js";

const bridgeSendSchema = (guarded: boolean) =>
	z
		.object({
			to: z
				.string()
				.optional()
				.describe(
					`
Session to send to.
- An offline session will auto-start and then be messaged.
- A nonexistent session (identified by \`to\`) will be created first.
`.trim(),
				),
			body: z.string().optional().describe(`Markdown request details and relevant context.`),
			displayLabel: z
				.string()
				.min(1)
				.max(64)
				.optional()
				.describe(
					`
Sets this new session's label. Required when creating a new session.
`.trim() + REAL_NEWLINES_GUIDANCE,
				),
			cli: z
				.enum(SESSION_HARNESSES)
				.optional()
				.describe(
					`
Sets this new session's CLI: \`claude\`, \`opencode\` or \`copilot\`.
Leave blank to use the spawn point's only CLI. If it has several, nothing is created and you get their names. Ask the user if unsure which to pick.
`.trim(),
				),
			disposition: z
				.enum(["asking", "informing", "closing"])
				.optional()
				.describe(
					`
What you need back. Set it on every send; omitted means \`asking\`.

- \`asking\`: you are waiting on a reply.
- \`informing\`: no reply needed. They stay silent unless it affects them in a way you would want to know now.
- \`closing\`: the thread is over. Silence is correct.
`.trim(),
				),
			session_id: z
				.string()
				.optional()
				.describe(
					`
Polling only. Pass \`session_id\` with no \`body\` to peek at a conversation's latest result.

Omit it for sends. Channel conversations derive from the sender and target pair.
`.trim(),
				),
			attachments: z
				.array(z.string())
				.optional()
				.describe(
					`
Absolute paths to send with \`body\`. Requires \`body\`.

The receiving agent gets local files listed in a \`[FILES]\` block.
`.trim(),
				),
		})
		.strict();
export const BridgeSendSchema = bridgeSendSchema(false);
type BridgeSendArgs = z.infer<typeof BridgeSendSchema>;

type SendResult = ResponsePayload & { error?: string; available?: string[] };

/** A refused send, worded here; the Gateway answers it as an error. */
function refusalText(answer: unknown, to: string | undefined): string | undefined {
	const { refused, target } = (answer ?? {}) as { refused?: unknown; target?: unknown };
	const parsed = SendRefusalSchema.safeParse(refused);
	if (!parsed.success) return undefined;
	return sendRefusalText(parsed.data, typeof target === "string" ? target : (to ?? ""));
}

const description = `
# Crosstalk Send

Send a request to another team.

Provide \`to\` and \`body\` to send. Conversations are reused automatically; do not manage \`session_id\` values.

Provide \`session_id\` alone, with no \`body\`, to peek at the latest stored result without consuming it.

Channel-mode replies arrive as \`<channel>\` notifications. A team may send several progress updates without closing the conversation.

## Disposition

Set \`disposition\` on every send. It is the only thing that lets a thread end; without it every message reads as a question and earns an acknowledgement that wakes you for nothing.

- \`asking\`: you need something back.
- \`informing\`: you need nothing back. They reply only if it affects them in a way you would want to know now.
- \`closing\`: the thread is over. Silence is correct.

## Attachments

Set \`attachments\` when the team needs an artifact, such as a screenshot or log. Replies can attach files too.

Relay responses verbatim unless the user requested a summary.
`.trim();

async function formatResult(
	result: SendResult,
	to?: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
	if (result.status === "starting" && result.target) {
		return { content: [{ type: "text" as const, text: startingText(result.target) }] };
	}
	const target = result.target || to || "team";
	const parts = [`Response from ${target}:`];
	if (result.status) parts.push(`Status: ${result.status}`);

	if (result.status === "completed") {
		if (result.response) parts.push(`\n${result.response}`);
	} else if (result.status === "clarification") {
		parts.push(`Question: ${result.question}`);
		parts.push(`\nTo answer, use crosstalk_send with session_id: "${result.session_id}"`);
	} else if (result.status === "deferred") {
		parts.push(`Reason: ${result.reason}`);
		if (result.estimated_minutes) parts.push(`Estimated wait: ${result.estimated_minutes} minutes`);
		parts.push(`\nYou can use crosstalk_wait to wait, then retry.`);
	} else if (result.status === "needs_human") {
		parts.push(`Reason: ${result.reason}`);
		if (result.what_to_decide) parts.push(`Decision needed: ${result.what_to_decide}`);
		parts.push(`\nThe other team needs their human. Inform yours.`);
	} else if (result.status === "running") {
		parts.push(result.message || `Still running.`);
		parts.push(`\nTo check again, call this tool with just session_id (no body).`);
	} else if (result.status === "error") {
		parts.push(`Error: ${result.reason ?? result.message ?? `Unknown error`}`);
	} else if (result.status === "timeout") {
		parts.push(result.message || `No response in time.`);
	} else {
		const body = result.response ?? result.message ?? result.reason;
		if (body) parts.push(`\n${body}`);
	}

	// A poll recovers names only. The stored copy holds no reference to the bytes.
	const attached = result.files ? dropReferenceArtifacts(result.files) : [];
	if (attached.length > 0) {
		parts.push(`\nAttachments on this reply (a poll recovers names only; ask for a re-send to get the bytes):`);
		// A peer-supplied newline would forge entries in this line-structured output.
		for (const f of attached) parts.push(`- ${f.filename.replace(/[\r\n]+/g, " ")}`);
	}

	if (result.session_id) parts.push(`\n[session_id: ${result.session_id}]`);

	return { content: [{ type: "text" as const, text: parts.join("\n") }] };
}

/** Guard assistant sends. */
export function registerBridgeSend(mcpServer: McpServer, { guarded = false }: { guarded?: boolean } = {}): void {
	mcpServer.registerTool(
		"crosstalk_send",
		{
			title: `Crosstalk Send`,
			description,
			// biome-ignore lint/suspicious/noExplicitAny: MCP SDK expects this type
			inputSchema: bridgeSendSchema(guarded) as any,
		},
		async ({ to, body, session_id, displayLabel, cli, disposition, attachments }: BridgeSendArgs) => {
			try {
				// Attachments exclude poll mode, or a files-only send would discard them.
				if (session_id && !body && !attachments?.length) {
					const result = (await routerPost("/poll", { session_id })) as SendResult;

					if (result.error) {
						return {
							content: [{ type: "text" as const, text: `Poll error: ${result.error}` }],
							isError: true,
						};
					}

					return await formatResult(result, to);
				}

				if (!to || !body) {
					throw new Error(`Provide to + body for sending, or just session_id for polling.`);
				}

				// `body` stays unlinted: its consumer is the receiving model, not a renderer.
				if (displayLabel) {
					const hazard = literalEscapeHazard(displayLabel);
					if (hazard) return toolError(literalEscapeReject("crosstalk_send", "displayLabel", hazard));
				}

				let files: ChannelFile[] = [];
				if (attachments?.length) {
					try {
						files = await readReplyAttachments(attachments);
					} catch (err) {
						return toolError(`Attachment error: ${(err as Error).message}`);
					}
				}

				const refusal = opLedgerRefusal();
				if (refusal) return toolError(`Cannot send: ${refusal}`);

				if (guarded) return await sendGuarded({ to, body, displayLabel, cli, disposition, files });

				// Minted here rather than inside routerPost, so its retries share one id.
				const result = (await routerPost("/send", {
					opId: crypto.randomUUID(),
					from: bridgeProjectName(),
					fromConversationId: bridgeConversationId(),
					to,
					body,
					...(displayLabel ? { displayLabel } : {}),
					...(cli ? { cli } : {}),
					...(disposition ? { disposition } : {}),
					...(files.length > 0 ? { files } : {}),
				})) as SendResult;

				if (result.error) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Bridge error: ${result.error}${result.available ? `\nAvailable: ${result.available.join(", ")}` : ""}`,
							},
						],
						isError: true,
					};
				}

				return formatResult(result, to);
			} catch (err) {
				const refused = err instanceof RouterHttpError ? refusalText(err.json, to) : undefined;
				if (refused) return toolError(refused);
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to send: ${message}` }],
					isError: true,
				};
			}
		},
	);
}
