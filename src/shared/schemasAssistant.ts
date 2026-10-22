// The assistant's console answers: where it lives on a Gateway, and its watchers there.

import { z } from "zod";
import { AssistantActionDescriptorSchema } from "./schemasAssistantActions.js";
import { AssistantWatcherRulesSchema } from "./schemasAssistantRules.js";

const AssistantWatcherBackoffSchema = z
	.object({ until: z.number().int(), reason: z.string() })
	.meta({ id: "AssistantWatcherBackoff" });

export const AssistantWatcherSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		/** Vault entries its standing grant names. */
		grants: z.array(z.string()),
		/** The source's unread count at the last poll that read it. */
		unread: z.number().int().nonnegative(),
		/** More unread than a poll reads. */
		capped: z.boolean().optional(),
		// Sent as 0 for older phones; remove 2026-11-02.
		evicted: z.number().int().nonnegative().optional(),
		lastSuccessAt: z.number().int().optional(),
		nextPollAt: z.number().int().optional(),
		backoff: AssistantWatcherBackoffSchema.optional(),
		stopped: z.string().optional(),
		/** What a rule may test. */
		fields: z.array(z.string()).optional(),
		rules: AssistantWatcherRulesSchema.optional(),
		/** The secret it needs, as shown; absent when it needs none. */
		secret: z.string().max(400).optional(),
		// Required starting 2026-11-04.
		actions: z.array(AssistantActionDescriptorSchema).optional(),
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
