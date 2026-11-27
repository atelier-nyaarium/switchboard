// The assistant's console answers: where it lives on a Gateway, and its sources there.

import { z } from "zod";
import { AssistantActionDescriptorSchema } from "./schemasAssistantActions.js";
import { AssistantFieldSpecSchema } from "./schemasAssistantRules.js";
import { SERVICE_KEYS } from "./schemasIntegrations.js";

const AssistantWatcherBackoffSchema = z
	.object({ until: z.number().int(), reason: z.string() })
	.meta({ id: "AssistantWatcherBackoff" });

/** Grant-bearing services. */
export const INTEGRATION_IDS = SERVICE_KEYS;

export const TemperatureUnitSchema = z.enum(["C", "F"]).meta({ id: "TemperatureUnit" });
export type TemperatureUnit = z.infer<typeof TemperatureUnitSchema>;

export const IntegrationSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		grants: z.array(z.string()),
	})
	.meta({ id: "AssistantIntegration" });

export type Integration = z.infer<typeof IntegrationSchema>;

/** A service that produces events. */
export const AssistantSourceSchema = z
	.object({
		id: z.string(),
		label: z.string(),
		/** Vault entries its standing grant names. */
		grants: z.array(z.string()),
		/** Unread at the last poll that read it. */
		unread: z.number().int().nonnegative(),
		/** More unread than a poll reads. */
		capped: z.boolean().optional(),
		lastSuccessAt: z.number().int().optional(),
		nextPollAt: z.number().int().optional(),
		backoff: AssistantWatcherBackoffSchema.optional(),
		stopped: z.string().optional(),
		/** What its events carry. */
		fieldSpecs: z.array(AssistantFieldSpecSchema),
		/** The secret it needs, as shown; absent when it needs none. */
		secret: z.string().max(400).optional(),
		actions: z.array(AssistantActionDescriptorSchema),
		/** Disabled polls nothing. */
		enabled: z.boolean(),
		/** Its events can trigger an automation. */
		triggers: z.boolean(),
	})
	.meta({ id: "AssistantSource" });

export type AssistantSource = z.infer<typeof AssistantSourceSchema>;

/** An op that lands answers the state it left. */
export const ConsoleAssistantStateResultSchema = z
	.object({
		/** The session's folder on this Gateway's host, or null when it lives elsewhere. */
		workdir: z.string().nullable(),
		team: z.string().nullable(),
		sources: z.array(AssistantSourceSchema),
		/** Omitted without send guard. */
		approveEverySend: z.boolean().optional(),
		temperatureUnit: TemperatureUnitSchema,
		/** Omitted by a Gateway that cannot hold a check-in. */
		checkIns: z.boolean().optional(),
		// skew:assistant-state-catalogue.
		integrations: z.array(IntegrationSchema).optional(),
		/** Catalogue ids this Gateway serves. */
		// skew:assistant-state-catalogue.
		offered: z.array(z.string().min(1).max(64)).max(64).optional(),
	})
	.meta({ id: "ConsoleAssistantStateResult" });

export type ConsoleAssistantStateResult = z.infer<typeof ConsoleAssistantStateResultSchema>;
