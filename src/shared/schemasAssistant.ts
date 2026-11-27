// The assistant's console answers: where it lives on a Gateway, and its sources there.

import { z } from "zod";
import { AssistantActionDescriptorSchema } from "./schemasAssistantActions.js";
import {
	AssistantFieldSpecSchema,
	AssistantRuleInvalidSchema,
	AssistantUnexpectedValuesSchema,
	AssistantWatcherRulesSchema,
} from "./schemasAssistantRules.js";
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
		// skew:watchers-field: sent as 0 for older phones.
		evicted: z.number().int().nonnegative().optional(),
		lastSuccessAt: z.number().int().optional(),
		nextPollAt: z.number().int().optional(),
		backoff: AssistantWatcherBackoffSchema.optional(),
		stopped: z.string().optional(),
		/** Testable fields from specs. */
		fields: z.array(z.string()).optional(),
		// skew:watchers-field.
		fieldSpecs: z.array(AssistantFieldSpecSchema).optional(),
		rules: AssistantWatcherRulesSchema.optional(),
		/** Spec-invalid held rules. */
		invalid: z.array(AssistantRuleInvalidSchema).optional(),
		/** Out-of-set event values. */
		unexpected: AssistantUnexpectedValuesSchema.optional(),
		/** The secret it needs, as shown; absent when it needs none. */
		secret: z.string().max(400).optional(),
		// skew:watchers-field.
		actions: z.array(AssistantActionDescriptorSchema).optional(),
		/** Disabled polls nothing. */
		// skew:watchers-field.
		enabled: z.boolean().optional(),
	})
	.meta({ id: "AssistantWatcher" });

export type AssistantWatcher = z.infer<typeof AssistantWatcherSchema>;

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
		/** Out-of-set event values. */
		unexpected: AssistantUnexpectedValuesSchema.optional(),
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
		// skew:watchers-field: an older phone reads it.
		watchers: z.array(AssistantWatcherSchema).optional(),
		// skew:watchers-field.
		sources: z.array(AssistantSourceSchema).optional(),
		/** Omitted without send guard. */
		approveEverySend: z.boolean().optional(),
		// skew:assistant-temperature-unit.
		temperatureUnit: TemperatureUnitSchema.optional(),
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
