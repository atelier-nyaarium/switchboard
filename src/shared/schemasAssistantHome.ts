// Where the assistant lives: one Router-held record per Domain owner.

import { z } from "zod";
import { AssistantWatcherRulesSchema } from "./schemasAssistantRules.js";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";

export const ASSISTANT_HOME_SEALED_MAX_BYTES = 65_536;
export const ASSISTANT_HOME_REASON_MAX = 512;
const WATCHERS_MAX = 16;

const gatewayId = z.string().min(1).max(64);
const version = z.number().int().positive();

export const AssistantHomeCarriedWatcherSchema = z
	.object({
		id: z.string().min(1).max(64),
		rules: AssistantWatcherRulesSchema,
		/** Its standing grant's entry. */
		grant: z.string().min(1).max(64).nullable(),
		/** Absent means on. */
		enabled: z.boolean().optional(),
	})
	.meta({ id: "AssistantHomeCarriedWatcher" });

/** What a move carries from the old home; null starts fresh. */
export const AssistantHomeCarriedSchema = z
	.object({
		approveEverySend: z.boolean(),
		watchers: z.array(AssistantHomeCarriedWatcherSchema).max(WATCHERS_MAX),
	})
	.meta({ id: "AssistantHomeCarried" });

/** The sealed half's plaintext. */
export const AssistantHomeSealedSchema = z
	.object({
		workdirPath: z.string().min(1).max(1_024),
		carried: AssistantHomeCarriedSchema.nullable(),
	})
	.meta({ id: "AssistantHomeSealed" });

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
