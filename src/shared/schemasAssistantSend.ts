// Send approval schemas.

import { z } from "zod";
import { ChannelFilesSchema } from "./channel-file.js";
import { CONVERSATION_ID_RE, MAX_CONVERSATION_ID_LEN } from "./host-op.js";
import { VAULT_ROUTE_WAIT_CAP_MS } from "./schemasVault.js";

const MAX_TARGET_LEN = 320;
const requestId = z.string().min(1).max(128);
const waitMs = z.number().int().nonnegative().optional();

export const SEND_DISPOSITIONS = ["asking", "informing", "closing"] as const;
/** Send clearance. */
export const SEND_GUARDS = ["approved", "unasked"] as const;
export const SEND_DECISIONS = ["approve", "deny"] as const;

export type SendGuard = (typeof SEND_GUARDS)[number];

/** One wait; collect again. */
export const SEND_ROUTE_WAIT_CAP_MS = VAULT_ROUTE_WAIT_CAP_MS;
export const SEND_NOTE_MAX = 2048;

export const AssistantSendFileSchema = z
	.strictObject({
		digest: z.string().regex(/^sha256-[0-9a-f]{64}$/),
		filename: z.string().min(1).max(255),
		mime: z.string().min(1).max(255),
		size: z.number().int().nonnegative(),
	})
	.meta({ id: "AssistantSendFile" });

/** Delivered exactly as bound. */
export const AssistantSendIntentSchema = z
	.strictObject({
		/** Canonical before binding. */
		target: z.string().min(1).max(MAX_TARGET_LEN),
		/** Target's friend Domain. */
		friendDomain: z.string().min(1).max(64).optional(),
		body: z.string(),
		disposition: z.enum(SEND_DISPOSITIONS).optional(),
		displayLabel: z.string().min(1).max(64).optional(),
		/** The label makes an absent target. */
		createsSession: z.boolean(),
		files: z.array(AssistantSendFileSchema).max(10),
	})
	.meta({ id: "AssistantSendIntent" });

export type AssistantSendIntent = z.infer<typeof AssistantSendIntentSchema>;

/** The owner's card. */
export const AssistantSendRequestSchema = z
	.strictObject({
		v: z.literal(1),
		requestId,
		sessionTarget: z.string().min(1).max(MAX_TARGET_LEN),
		deadlineAt: z.number().int(),
		intent: AssistantSendIntentSchema,
	})
	.meta({ id: "AssistantSendRequest" });

export type AssistantSendRequest = z.infer<typeof AssistantSendRequestSchema>;

export const AssistantSendRetractSchema = z.strictObject({ requestId }).meta({ id: "AssistantSendRetract" });

export const ConsoleAssistantSendAnswerResultSchema = z
	.object({ ok: z.boolean(), reason: z.string().optional() })
	.meta({ id: "ConsoleAssistantSendAnswerResult" });

export type ConsoleAssistantSendAnswerResult = z.infer<typeof ConsoleAssistantSendAnswerResultSchema>;

/** Loopback request shapes. */
export const AssistantSendBodySchema = z.object({
	to: z.string().min(1).max(MAX_TARGET_LEN),
	body: z.string().min(1),
	displayLabel: z.string().min(1).max(64).optional(),
	disposition: z.enum(SEND_DISPOSITIONS).optional(),
	files: ChannelFilesSchema.optional(),
	fromConversationId: z.string().regex(CONVERSATION_ID_RE).max(MAX_CONVERSATION_ID_LEN),
	waitMs,
});

export const AssistantSendCollectSchema = z.object({ requestId, waitMs });
export const AssistantSendWithdrawSchema = z.object({ requestId });

export const AssistantSendAnswerSchema = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("sent"),
		sessionId: z.string(),
		target: z.string(),
		guard: z.enum(SEND_GUARDS),
	}),
	z.object({ outcome: z.literal("pending"), requestId, deadlineAt: z.number().int() }),
	z.object({ outcome: z.literal("denied"), note: z.string().optional() }),
	z.object({ outcome: z.literal("expired") }),
	z.object({ outcome: z.literal("withdrawn") }),
	z.object({ outcome: z.literal("failed"), reason: z.string() }),
]);

export type AssistantSendAnswer = z.infer<typeof AssistantSendAnswerSchema>;

export const AssistantSendWithdrawAnswerSchema = z.object({ withdrawn: z.boolean() });

export const ASSISTANT_SEND_ROUTES = {
	send: "/assistant/send",
	collect: "/assistant/send/collect",
	withdraw: "/assistant/send/withdraw",
} as const;
