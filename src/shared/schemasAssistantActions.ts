// Shared data-only action registry.

import { z } from "zod";
import { RECORD_SUMMARY_MAX, RECORD_THREADS_MAX, RecordThreadSchema } from "./schemasAssistantRecord.js";

export const GITHUB_WATCHER_ID = "github";

export const ASSISTANT_ACTION_PATH = "/assistant/action";

const SummarySchema = z
	.string()
	.max(RECORD_SUMMARY_MAX)
	.refine((summary) => summary.trim().length > 0, "a summary says something")
	.describe("Your message to the owner. Omit to clear quietly.");

/** Per-id source result. */
const ActionAnswerSchema = z.strictObject({
	threads: z.array(RecordThreadSchema).max(RECORD_THREADS_MAX),
	/** Why others were skipped. */
	note: z.string().max(400).optional(),
});

export type ActionAnswer = z.infer<typeof ActionAnswerSchema>;

export interface AssistantActionDeclaration {
	/** Calls cannot choose the watcher. */
	watcherId: string;
	label: string;
	/** Owner-visible, single-line text. */
	description: string;
	/** For the model. */
	usage: string;
	/** Records any supplied summary. */
	params: { summary: z.ZodOptional<typeof SummarySchema> } & z.ZodRawShape;
	answer: z.ZodType<ActionAnswer>;
}

export const ASSISTANT_ACTIONS = {
	github_done: {
		watcherId: GITHUB_WATCHER_ID,
		label: "Mark done",
		description: "Clears threads from your GitHub inbox.",
		usage: `
# GitHub Done

Mark GitHub notification threads done, then read, as GitHub's own Done does, so they leave \`inbox\`. Each id is an event's \`id\`.

- With \`summary\`: the owner gets it as your message, with the threads listed under it.
- Without: one quiet line, no notification.

Answers per id what GitHub confirmed, and whether your summary was recorded.

- \`not_attempted\`: safe to send again. Once your summary is recorded, send the rest without it.
- \`rate_limited\`: GitHub refused; the note names the wait.
- \`uncertain\`: may already be done.
		`.trim(),
		params: {
			ids: z
				.array(z.string().regex(/^\d{1,32}$/))
				.min(1)
				.max(RECORD_THREADS_MAX)
				.refine((ids) => new Set(ids).size === ids.length, "each id once")
				.describe("Thread ids, as events and `inbox` give them."),
			summary: SummarySchema.optional(),
		},
		answer: ActionAnswerSchema,
	},
} as const satisfies Record<string, AssistantActionDeclaration>;

export type AssistantActionKey = keyof typeof ASSISTANT_ACTIONS;

export const ASSISTANT_ACTION_KEYS = Object.keys(ASSISTANT_ACTIONS) as AssistantActionKey[];

export type ParamsOf<K extends AssistantActionKey> = z.infer<z.ZodObject<(typeof ASSISTANT_ACTIONS)[K]["params"]>>;
export type AnswerOf<K extends AssistantActionKey> = z.infer<(typeof ASSISTANT_ACTIONS)[K]["answer"]>;

export const AssistantActionRequestSchema = z.strictObject({
	action: z.enum(ASSISTANT_ACTION_KEYS as [AssistantActionKey, ...AssistantActionKey[]]),
	/** Retries reuse the call id. */
	callId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
	params: z.unknown(),
});

export type AssistantActionRequest = z.infer<typeof AssistantActionRequestSchema>;

export const AssistantActionResultSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("not_assistant") }),
	z.strictObject({ kind: z.literal("unauthenticated") }),
	z.strictObject({ kind: z.literal("refused"), reason: z.string().max(400) }),
	/** Action-specific answer schema. */
	z.strictObject({ kind: z.literal("ran"), answer: z.unknown(), recorded: z.boolean() }),
]);

export type AssistantActionResult = z.infer<typeof AssistantActionResultSchema>;

/** Phone-visible watcher actions. */
export const AssistantActionDescriptorSchema = z
	.object({ key: z.string(), label: z.string(), description: z.string() })
	.meta({ id: "AssistantActionDescriptor" });

export type AssistantActionDescriptor = z.infer<typeof AssistantActionDescriptorSchema>;

export function actionsOf(watcherId: string): AssistantActionDescriptor[] {
	return ASSISTANT_ACTION_KEYS.filter((key) => ASSISTANT_ACTIONS[key].watcherId === watcherId).map((key) => ({
		key,
		label: ASSISTANT_ACTIONS[key].label,
		description: ASSISTANT_ACTIONS[key].description,
	}));
}
