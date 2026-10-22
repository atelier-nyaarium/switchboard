import { z } from "zod";

export const ACTION_OUTCOMES = ["done", "not_found", "rate_limited", "uncertain", "not_attempted"] as const;

export const ActionOutcomeSchema = z.enum(ACTION_OUTCOMES);

export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;

export const RECORD_THREADS_MAX = 50;
export const RECORD_SUMMARY_MAX = 300;
const TITLE_MAX = 300;
const URL_MAX = 512;

/** Titles and links are source facts; missing means unread. */
export const RecordThreadSchema = z
	.object({
		threadId: z.string().min(1).max(64),
		title: z.string().min(1).max(TITLE_MAX).optional(),
		url: z
			.string()
			.max(URL_MAX)
			.regex(/^https:\/\//)
			.optional(),
		outcome: ActionOutcomeSchema,
	})
	.meta({ id: "AssistantRecordThread" });

export type RecordThread = z.infer<typeof RecordThreadSchema>;
