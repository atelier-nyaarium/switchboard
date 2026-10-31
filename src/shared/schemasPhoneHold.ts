// Router-owned phone hold.

import { z } from "zod";

export const PHONE_HOLD_PLANE = "phoneHold";

export const PHONE_HOLD_WINDOW_MS = 10 * 60_000;

const holderField = z.string().min(1).max(64);

export const PhoneHoldRecordSchema = z
	.object({
		/** Console signing key. */
		holder: holderField,
		/** Device name, not unique. */
		label: z.string().min(1).max(64),
		/** Router timestamp. */
		claimedAt: z.number().int().nonnegative(),
		version: z.number().int().positive(),
	})
	.meta({ id: "PhoneHold" });

export type PhoneHoldRecord = z.infer<typeof PhoneHoldRecordSchema>;

export const PhoneHoldPlaneSchema = z.object({ hold: PhoneHoldRecordSchema.nullable() }).meta({ id: "PhoneHoldPlane" });

export type PhoneHoldPlane = z.infer<typeof PhoneHoldPlaneSchema>;

/** Signed device claims hold. */
export const HoldClaimValueSchema = z.object({ kind: z.literal("hold_claim") }).meta({ id: "HoldClaimValue" });

export const HoldClaimResultSchema = z.object({ hold: PhoneHoldRecordSchema }).meta({ id: "HoldClaimResult" });

export type HoldClaimResult = z.infer<typeof HoldClaimResultSchema>;

export const PhoneHoldReadValueSchema = z
	.object({ kind: z.literal("phone_hold_read") })
	.meta({ id: "PhoneHoldReadValue" });

/** Router pushes every hold change. */
export const PhoneHoldFrameSchema = z
	.object({
		type: z.literal("phone_hold"),
		incarnation: z.number().int().positive(),
		hold: PhoneHoldRecordSchema.nullable(),
	})
	.meta({ id: "PhoneHoldFrame" });

export type PhoneHoldFrame = z.infer<typeof PhoneHoldFrameSchema>;

export type HoldStanding = "held" | "lapsed" | "none";

/** Use one clock. */
export function holdStanding(
	hold: Pick<PhoneHoldRecord, "holder" | "claimedAt"> | null,
	now: number,
	windowMs: number = PHONE_HOLD_WINDOW_MS,
): HoldStanding {
	if (hold === null) return "none";
	return now - hold.claimedAt < windowMs ? "held" : "lapsed";
}
