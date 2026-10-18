// The assistant's console answers: where it lives on a Gateway, and its watchers there.

import { z } from "zod";
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
		unread: z.number().int().nonnegative(),
		evicted: z.number().int().nonnegative(),
		lastSuccessAt: z.number().int().optional(),
		nextPollAt: z.number().int().optional(),
		backoff: AssistantWatcherBackoffSchema.optional(),
		stopped: z.string().optional(),
		/** What a rule may test. */
		fields: z.array(z.string()).optional(),
		pingDefault: z.boolean().optional(),
		rules: AssistantWatcherRulesSchema.optional(),
		/** Drops a rule edit replays. */
		dropped: z.number().int().nonnegative().optional(),
		/** Events that woke the assistant, kept 14 days. */
		woken: z.number().int().nonnegative().optional(),
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
