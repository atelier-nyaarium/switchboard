import { z } from "zod";

////////////////////////////////
//  Gateway Setup to its own Gateway, over loopback

export const ENROLL_ARM_PATH = "/enroll/arm";
export const ENROLL_STATUS_PATH = "/enroll/status";

export const EnrollArmRequestSchema = z.object({
	host: z.string().min(1),
	port: z.number().int().min(1).max(65535).optional(),
});

/** What the phone scans. */
export const EnrollGatewayPayloadSchema = z.object({
	type: z.literal("enroll-gateway"),
	gatewayId: z.string().min(1),
	signPub: z.string().min(1),
	boxPub: z.string().min(1),
	/** One-time and secret: a bundle must carry it back. */
	code: z.string().min(1),
});

export type EnrollGatewayPayload = z.infer<typeof EnrollGatewayPayloadSchema>;

export const EnrollArmAnswerSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), payload: EnrollGatewayPayloadSchema, router: z.string() }),
	z.object({
		ok: z.literal(false),
		error: z.enum(["already_enrolled", "router_unreachable", "closing", "unauthorized", "invalid"]),
		router: z.string().optional(),
		reason: z.string().optional(),
	}),
]);

export type EnrollArmAnswer = z.infer<typeof EnrollArmAnswerSchema>;

export const EnrollStatusSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("none") }),
	z.object({ state: z.literal("waiting") }),
	z.object({ state: z.literal("unreachable"), router: z.string(), reason: z.string() }),
	/** A bundle arrived and was not installed. */
	z.object({ state: z.literal("refused"), reason: z.string() }),
	z.object({ state: z.literal("installed"), domain: z.string().nullable() }),
]);

export type EnrollStatus = z.infer<typeof EnrollStatusSchema>;
