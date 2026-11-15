// Where the assistant lives: one Router-held record per Domain owner.

import { z } from "zod";
import { INTEGRATION_IDS, TemperatureUnitSchema } from "./schemasAssistant.js";
import { AssistantWatcherRulesSchema } from "./schemasAssistantRules.js";
import { AUTOMATIONS_MAX, CarriedAutomationSchema } from "./schemasAutomation.js";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";

export const ASSISTANT_HOME_SEALED_MAX_BYTES = 65_536;
export const ASSISTANT_HOME_REASON_MAX = 512;
const WATCHERS_MAX = 16;

const gatewayId = z.string().min(1).max(64);
const version = z.number().int().positive();

export const AssistantHomeCarriedWatcherSchema = z
	.object({
		id: z.string().min(1).max(64),
		// Remove 2026-11-28: an older Gateway reads rules.
		rules: AssistantWatcherRulesSchema.nullish(),
		/** Its standing grant's entry. */
		grant: z.string().min(1).max(64).nullable(),
		/** Absent means on. */
		enabled: z.boolean().nullish(),
	})
	.meta({ id: "AssistantHomeCarriedWatcher" });

export const AssistantHomeCarriedIntegrationSchema = z
	.object({
		id: z.enum(INTEGRATION_IDS),
		grant: z.string().min(1).max(64).nullable(),
	})
	.meta({ id: "AssistantHomeCarriedIntegration" });

/**
 * What a move carries from the old home; null starts fresh. The phone seals an unset field as
 * null, so nothing optional here may refuse one.
 */
export const AssistantHomeCarriedSchema = z
	.object({
		approveEverySend: z.boolean(),
		// Required starting 2026-11-27.
		temperatureUnit: TemperatureUnitSchema.nullish(),
		watchers: z.array(AssistantHomeCarriedWatcherSchema).max(WATCHERS_MAX),
		/** The sources' event automations; unset from an older phone or home. */
		automations: z.array(CarriedAutomationSchema).max(AUTOMATIONS_MAX).nullish(),
		// Required starting 2026-11-15. Null from a phone that read an older Gateway.
		integrations: z.array(AssistantHomeCarriedIntegrationSchema).nullish(),
	})
	.meta({ id: "AssistantHomeCarried" });

/** The sealed half's plaintext. */
export const AssistantHomeSealedSchema = z
	.object({
		workdirPath: z.string().min(1).max(1_024),
		carried: AssistantHomeCarriedSchema.nullable(),
	})
	.meta({ id: "AssistantHomeSealed" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Drops each carried member this build cannot read, never the move. */
export function readableSealed(raw: unknown): { sealed: unknown; dropped: number } {
	if (!isRecord(raw) || !isRecord(raw.carried)) return { sealed: raw, dropped: 0 };
	let dropped = 0;
	const kept = (items: unknown, schema: z.ZodType): unknown => {
		if (!Array.isArray(items)) return items;
		const readable = items.filter((item) => schema.safeParse(item).success);
		dropped += items.length - readable.length;
		return readable;
	};
	const carried = {
		...raw.carried,
		automations: kept(raw.carried.automations, CarriedAutomationSchema),
		integrations: kept(raw.carried.integrations, AssistantHomeCarriedIntegrationSchema),
	};
	return { sealed: { ...raw, carried }, dropped };
}

/** `gatewayId` null is nobody, and seals nothing. */
export const AssistantHomeRecordSchema = z
	.object({
		version,
		gatewayId: gatewayId.nullable(),
		sealed: ContentEnvelopeSchema.nullable(),
	})
	.refine(
		(record) => (record.gatewayId === null) === (record.sealed === null),
		"gatewayId and sealed are set together",
	)
	.meta({ id: "AssistantHomeRecord" });

/** The named Gateway's one answer to a choice version. */
export const AssistantHomeReportSchema = z
	.object({
		version,
		gatewayId,
		outcome: z.enum(["placed", "refused"]).meta({ id: "AssistantHomeOutcome", catalog: "outcome" }),
		reason: z.string().max(ASSISTANT_HOME_REASON_MAX).optional(),
	})
	.meta({ id: "AssistantHomeReport" });

export const AssistantHomeReadValueSchema = z
	.object({ kind: z.literal("assistant_home_read") })
	.meta({ id: "AssistantHomeReadValue" });

/** A null record was never written; a report shows only for the current version. */
export const AssistantHomeReadResultSchema = z
	.object({
		record: AssistantHomeRecordSchema.nullable(),
		report: AssistantHomeReportSchema.nullable(),
	})
	.meta({ id: "AssistantHomeReadResult" });

/** `baseVersion` 0 writes the first record. */
export const AssistantHomePutValueSchema = z
	.object({
		kind: z.literal("assistant_home_put"),
		baseVersion: z.number().int().nonnegative(),
		gatewayId: gatewayId.nullable(),
		sealed: ContentEnvelopeSchema.nullable(),
	})
	.refine((put) => (put.gatewayId === null) === (put.sealed === null), "gatewayId and sealed are set together")
	.meta({ id: "AssistantHomePutValue" });

export const AssistantHomeRefusalSchema = z
	.enum(["unroutable", "too_large", "durability_failure"])
	.meta({ id: "AssistantHomeRefusal", catalog: "refusal" });

/** `record` is what is held after the put: the applied one, the winner, or the untouched one. */
export const AssistantHomePutResultSchema = z
	.object({
		outcome: z.enum(["applied", "conflict", "refused"]).meta({ id: "AssistantHomePutOutcome", catalog: "outcome" }),
		record: AssistantHomeRecordSchema.nullable(),
		refusal: AssistantHomeRefusalSchema.optional(),
	})
	.meta({ id: "AssistantHomePutResult" });

/** Router to Gateway, on every change. */
export const AssistantHomeFrameSchema = z.object({
	type: z.literal("assistant_home"),
	incarnation: z.number().int().positive(),
	record: AssistantHomeRecordSchema,
});

/** Gateway to Router. */
export const AssistantHomeReportParamsSchema = z.object({
	version,
	outcome: z.enum(["placed", "refused"]),
	reason: z.string().max(ASSISTANT_HOME_REASON_MAX).optional(),
});

export type AssistantHomeCarried = z.infer<typeof AssistantHomeCarriedSchema>;
export type AssistantHomeSealed = z.infer<typeof AssistantHomeSealedSchema>;
export type AssistantHomeRecord = z.infer<typeof AssistantHomeRecordSchema>;
export type AssistantHomeReport = z.infer<typeof AssistantHomeReportSchema>;
export type AssistantHomeReadResult = z.infer<typeof AssistantHomeReadResultSchema>;
export type AssistantHomePutValue = z.infer<typeof AssistantHomePutValueSchema>;
export type AssistantHomePutResult = z.infer<typeof AssistantHomePutResultSchema>;
export type AssistantHomeReportParams = z.infer<typeof AssistantHomeReportParamsSchema>;
