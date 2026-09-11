import { z } from "zod";
import { CrossDomainShareTargetSchema } from "./schemasConsoleOp.js";

const sessionTarget = z
	.string()
	.min(7)
	.max(128)
	.regex(/^[^|/\r\n]+\.[^|/\r\n]+\.[^|/\r\n]+\.[^|/\r\n]+$/);
const domainId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[^|/\r\n]+$/);

export const ShareJobLiveParamsSchema = z
	.object({
		incarnation: z.number().int().positive(),
		sessionTarget,
		jobIds: z.array(z.string().min(1).max(128)),
		observedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "ShareJobLiveParams" });

export const CrossDomainShareValueSchema = z
	.object({ sessionTarget, target: CrossDomainShareTargetSchema })
	.meta({ id: "CrossDomainShareValue" });

export const CrossDomainUnshareValueSchema = z
	.object({ sessionTarget, target: CrossDomainShareTargetSchema })
	.meta({ id: "CrossDomainUnshareValue" });

export const CrossDomainUnlinkValueSchema = z.object({ domainId }).meta({ id: "CrossDomainUnlinkValue" });

export const CrossDomainListSharesValueSchema = z.object({}).meta({ id: "CrossDomainListSharesValue" });

const shareRecord = z.object({ sessionTarget, target: CrossDomainShareTargetSchema, lastSeenAt: z.number().int() });
const revision = z.number().int().nonnegative();

/** Gateway share set. */
export const ShareMirrorSnapshotSchema = z.object({ revision, shares: z.array(shareRecord) });

/** Gateway share delta. */
export const ShareMirrorDeltaSchema = z.object({
	revision,
	put: z.array(shareRecord),
	del: z.array(z.object({ sessionTarget, target: CrossDomainShareTargetSchema })),
});

export type ShareJobLiveParams = z.infer<typeof ShareJobLiveParamsSchema>;
export type ShareMirrorSnapshot = z.infer<typeof ShareMirrorSnapshotSchema>;
export type ShareMirrorDelta = z.infer<typeof ShareMirrorDeltaSchema>;
