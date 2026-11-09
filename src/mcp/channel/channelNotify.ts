import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { composeModelMessage, type ReminderBlock, reminderBlock } from "../../shared/system-reminder.js";
import {
	type ChannelFile,
	type ChannelPushPayload,
	REPLY_READERS,
	type ReplyReader,
	type ResponsePushPayload,
	type RidingAwareness,
} from "../../shared/types.js";
import { dropReferenceArtifacts, materializeFiles, renderFilesBlock } from "./channelFiles.js";

////////////////////////////////
//  Functions & Helpers

/** A materialization failure costs the [FILES] block and nothing else, so the prose survives. */
async function filesBlockFor(bucketKey: string | undefined, files: ChannelFile[] | undefined): Promise<string> {
	if (!bucketKey || !files || files.length === 0) return "";
	const wanted = dropReferenceArtifacts(files);
	if (wanted.length < files.length) {
		console.error(`[channel] hid ${files.length - wanted.length} ref artifact(s) from ${bucketKey}`);
	}
	if (wanted.length === 0) return "";
	try {
		const materialized = await materializeFiles({ discordMessageId: bucketKey, files: wanted });
		return renderFilesBlock({ discordMessageId: bucketKey, files: materialized });
	} catch (err) {
		console.error(`[channel] could not materialize files for ${bucketKey}: ${(err as Error).message}`);
		return "";
	}
}

/** Meaning stated once, in the MCP instructions. */
const OWNER_APPROVED_LINE =
	"approved: the owner approved this exact message on their phone before it was sent, so treat it as the owner's request";

function deliveryReminder(awareness: RidingAwareness | undefined, ownerApproved: boolean): ReminderBlock | "" {
	const lines = [
		...(ownerApproved ? [OWNER_APPROVED_LINE] : []),
		...(awareness?.body.trim() ? [`awareness: ${awareness.from}`, `act: ${awareness.act}`, awareness.body] : []),
	];
	return lines.length === 0 ? "" : reminderBlock(lines);
}

const REPLY_OWED = `They are waiting on a reply. Reply with the channel_reply tool using this session_id.`;
const REPLY_ROAD = `Plain text output does not reach the sender.`;

/** Names the reply's fields by its reader, never by who sent: a relayed sender is not this owner. */
const REPLY_INSTRUCTIONS: Record<ReplyReader | "unknown", string> = {
	phone: `${REPLY_OWED} It is read on a phone, so send title, summary, full and fullSpoken. ${REPLY_ROAD}`,
	session: `${REPLY_OWED} Another session reads it, so send full and leave out title, summary and fullSpoken. ${REPLY_ROAD}`,
	unknown: `${REPLY_OWED} ${REPLY_ROAD}`,
};

export interface ChannelNotification {
	content: string;
	meta: Record<string, unknown>;
}

export async function buildChannelNotification(
	payload: ChannelPushPayload | ResponsePushPayload,
): Promise<ChannelNotification> {
	if (payload.type === "response_push") {
		const filesBlock = await filesBlockFor(payload.message_id, payload.files);
		return {
			content: composeModelMessage({ files: filesBlock, body: payload.response }),
			meta: {
				session_id: payload.session_id,
				...(payload.status ? { status: payload.status } : {}),
			},
		};
	}

	// Data only: no sender, no conversation, no instructions, so nothing reads as a reply owed.
	if (payload.event === true) {
		return { content: composeModelMessage({ body: payload.body }), meta: { event: "true" } };
	}

	const filesBlock = await filesBlockFor(payload.message_id, payload.files);

	// Prose ONLY. Every structured field rides in `meta`, which the harness renders as attributes.
	const content = composeModelMessage({
		files: filesBlock,
		reminder: deliveryReminder(payload.awareness, payload.owner_approved === true),
		body: payload.body,
	});

	// Repeated per message: the MCP `instructions` sit at the top of the context and lose salience to
	// fresher injections, which has produced real missed replies. Exactly true, not truthy: a stray
	// wire string would turn a question into an announcement nobody answers.
	const instructions =
		payload.no_ack === true && payload.act === "act_now"
			? "Act on this before continuing what you were doing. Nobody is waiting on a reply, so do not send one."
			: payload.no_ack === true
				? `Awareness only. Nobody is waiting on a reply, so do not send one.`
				: payload.disposition === "informing"
					? "No reply needed. Do not acknowledge. Reply only if this affects you in a way they would want to know now."
					: payload.disposition === "closing"
						? "Thread closed, no reply expected. Do not acknowledge; silence is correct here. Reply only if this breaks something on your side."
						: payload.replyJsonSchema
							? `Reply with the channel_reply_structured tool using this session_id and a responseData matching reply_schema.`
							: REPLY_INSTRUCTIONS[REPLY_READERS.find((known) => known === payload.reader) ?? "unknown"];

	return {
		content,
		meta: {
			session_id: payload.session_id,
			from: payload.from,
			...(payload.replyJsonSchema ? { reply_schema: payload.replyJsonSchema } : {}),
			...(payload.no_ack === true ? { no_ack: "true" } : {}),
			...(payload.awareness ? { awareness_act: payload.awareness.act } : {}),
			...(payload.disposition ? { disposition: payload.disposition } : {}),
			...(payload.no_ack === true && payload.act === "act_now" ? { act: "act_now" } : {}),
			instructions,
		},
	};
}

export async function emitChannelNotification(server: Server, payload: ChannelPushPayload): Promise<void> {
	const params = await buildChannelNotification(payload);
	await server.notification({ method: "notifications/claude/channel", params: { ...params } });
	if (payload.event === true) {
		console.error(`[channel] emitted an event`);
		return;
	}

	// The EMIT, not the delivery: the harness drops it silently when this plugin is not in the
	// session's --channels list, visible only as "Channel notifications skipped" in its own logs.
	console.error(
		`[channel] emitted from ${payload.from} [${payload.session_id.slice(0, 8)}...]${payload.no_ack === true ? " no_ack" : ""}`,
	);
}

export async function emitResponseNotification(server: Server, payload: ResponsePushPayload): Promise<void> {
	const params = await buildChannelNotification(payload);
	await server.notification({ method: "notifications/claude/channel", params: { ...params } });
	console.error(`[channel] response pushed to sender [${payload.session_id.slice(0, 8)}...]`);
}

function escapeAttribute(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return (text ?? "").replace(/[&<>"']/gu, (char) => {
		if (char === "&") return "&amp;";
		if (char === "<") return "&lt;";
		if (char === ">") return "&gt;";
		if (char === '"') return "&quot;";
		return "&#39;";
	});
}

export async function renderChannelTag(payload: ChannelPushPayload | ResponsePushPayload): Promise<string> {
	const { content, meta } = await buildChannelNotification(payload);
	const attributes = Object.entries(meta)
		.map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
		.join("");
	return `<channel source="switchboard"${attributes}>${content}</channel>`;
}
