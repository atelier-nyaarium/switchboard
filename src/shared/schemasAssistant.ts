// The assistant's console answers: where it lives on a Gateway, and its watchers there.

import { z } from "zod";

const AssistantWatcherBackoffSchema = z
	.object({ until: z.number().int(), reason: z.string() })
	.meta({ id: "AssistantWatcherBackoff" });

export const AssistantWatcherSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		/** Vault entries its standing grant names. */
		grants: z.array(z.string()),
		unread: z.number().int().nonnegative(),
		evicted: z.number().int().nonnegative(),
		lastSuccessAt: z.number().int().optional(),
		nextPollAt: z.number().int().optional(),
		backoff: AssistantWatcherBackoffSchema.optional(),
		stopped: z.string().optional(),
	})
	.meta({ id: "AssistantWatcher" });

export type AssistantWatcher = z.infer<typeof AssistantWatcherSchema>;

/** An op that lands answers the state it left. */
export const ConsoleAssistantStateResultSchema = z
	.object({
		/** The session's folder on this Gateway's host, or null when it lives elsewhere. */
		workdir: z.string().nullable(),
		team: z.string().nullable(),
		watchers: z.array(AssistantWatcherSchema),
	})
	.meta({ id: "ConsoleAssistantStateResult" });

export type ConsoleAssistantStateResult = z.infer<typeof ConsoleAssistantStateResultSchema>;
