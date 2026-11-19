import { z } from "zod";
import { slugField } from "./crypto.js";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";

const targetShape = {
	domainId: slugField(),
	gatewayId: slugField(),
	sessionId: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[^/\r\n]+$/),
};

export const ScheduledTargetSchema = z.object(targetShape).meta({ id: "ScheduledTarget" });

/** Failure reasons. */
export const SCHEDULED_FAILURE_REASONS = [
	"malformed_body",
	"bad_tag",
	"delivery_unavailable",
	"target_mismatch",
	"delivery_refused",
	"delivery_failed",
] as const;

export type ScheduledFailureReason = (typeof SCHEDULED_FAILURE_REASONS)[number];

/** Maps reason to token. */
export function scheduledFailureReason(reason: string | undefined): ScheduledFailureReason {
	const known = SCHEDULED_FAILURE_REASONS.find((token) => token === reason);
	return known ?? "delivery_failed";
}

export const ScheduledRecordSchema = z
	.object({
		target: ScheduledTargetSchema,
		fireAt: z.number().int().nonnegative(),
		createdAt: z.number().int().nonnegative(),
		opId: z.string().min(1).max(128),
		sender: z
			.object({ conversationId: z.string().min(1).max(128), device: z.string().min(1).max(64) })
			.meta({ id: "ScheduledSender" }),
		files: z.array(z.string()).max(64),
		body: ContentEnvelopeSchema,
		state: z.enum(["armed", "firing", "fired", "error", "cancelled"]),
		// Only on an `error` record.
		reason: z.enum(SCHEDULED_FAILURE_REASONS).optional(),
		attempts: z.number().int().nonnegative(),
		version: z.number().int().positive(),
	})
	.meta({ id: "ScheduledRecord" });

export const ScheduleSendValueSchema = z
	.object({
		kind: z.literal("schedule_send").meta({ catalog: "owner-op-kind" }),
		target: ScheduledTargetSchema,
		fireAt: z.number().int().nonnegative(),
		opId: z
			.string()
			.min(1)
			.max(120)
			.regex(/^[^/\r\n]+$/),
		files: z.array(z.string()).max(64),
		body: ContentEnvelopeSchema,
		expectedVersion: z.number().int().positive().optional(),
	})
	.meta({ id: "ScheduleSendValue" });

export const ScheduleCancelValueSchema = z
	.object({
		kind: z.literal("schedule_cancel"),
		target: ScheduledTargetSchema,
		expectedVersion: z.number().int().positive(),
	})
	.meta({ id: "ScheduleCancelValue" });

export const ScheduleListValueSchema = z.object({ kind: z.literal("schedule_list") }).meta({ id: "ScheduleListValue" });

/** Too many files. */
export const SCHEDULE_REFUSED_TOO_MANY_FILES = "too_many_files";

export const ScheduledResultRowSchema = z
	.object({
		opId: z.string().min(1).max(128),
		outcome: z.enum(["pending", "sent", "failed"]),
		seq: z.number().int().positive().optional(),
		// Absent when unknown.
		reason: z.enum(SCHEDULED_FAILURE_REASONS).optional(),
		body: ContentEnvelopeSchema,
	})
	.meta({ id: "ScheduledResultRow" });

export type ScheduledTarget = z.infer<typeof ScheduledTargetSchema>;
export type ScheduledRecord = z.infer<typeof ScheduledRecordSchema>;
export type ScheduleSendValue = z.infer<typeof ScheduleSendValueSchema>;
export type ScheduleCancelValue = z.infer<typeof ScheduleCancelValueSchema>;
export type ScheduledResultRow = z.infer<typeof ScheduledResultRowSchema>;
