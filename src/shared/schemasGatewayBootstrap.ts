import { z } from "zod";
import { DomainSnapshotSchema, SignedAdmissionSchema } from "./admission.js";
import { b64Field } from "./crypto.js";
import { SealedEnvelopeSchema } from "./schemasConsoleOp.js";
import { KeyEnvelopeSchema } from "./schemasContentKey.js";
import { GatewayTransportSchema } from "./schemasGatewayTransport.js";

////////////////////////////////
//  Gateway bootstrap bundle: sealed to the Gateway, so the Router carrying it reads nothing

export const GatewayBootstrapBundleSchema = z
	.object({
		// The Gateway's one-time code.
		nonce: z.string().min(1),
		transport: GatewayTransportSchema,
		admission: SignedAdmissionSchema,
		domain: DomainSnapshotSchema,
		// Recorded so the next boot resolves the same Domain.
		domainId: z.string().min(1).max(64).optional(),
		contentKeys: z.array(KeyEnvelopeSchema).optional(),
	})
	.meta({ id: "GatewayBootstrapBundle" });

export type GatewayBootstrapBundle = z.infer<typeof GatewayBootstrapBundleSchema>;

////////////////////////////////
//  The sealed frame on the wire

export const GatewayBootstrapFrameSchema = z
	.object({
		v: z.number().int().positive(),
		signerSignPub: z.string().min(1),
		sealed: SealedEnvelopeSchema,
	})
	.meta({ id: "GatewayBootstrapFrame" });

export type GatewayBootstrapFrame = z.infer<typeof GatewayBootstrapFrameSchema>;

////////////////////////////////
//  Carried by the Router

/** Names a held frame. Hashed from the code, which the Router never sees. */
const PickupIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A 32-byte key is 44 characters. */
const GatewayKeySchema = b64Field().max(64);

export const GatewayBootstrapPutValueSchema = z
	.object({
		kind: z.literal("gateway_bootstrap_put"),
		pickupId: PickupIdSchema,
		gatewaySignPub: GatewayKeySchema,
		frame: GatewayBootstrapFrameSchema,
	})
	.meta({ id: "GatewayBootstrapPutValue" });

export const GATEWAY_BOOTSTRAP_REFUSALS = ["bad_frame", "not_admitted", "too_large", "too_many", "taken"] as const;

export type GatewayBootstrapRefusal = (typeof GATEWAY_BOOTSTRAP_REFUSALS)[number];

export const GatewayBootstrapPutResultSchema = z
	.object({ held: z.boolean(), refusal: z.enum(GATEWAY_BOOTSTRAP_REFUSALS).optional() })
	.meta({ id: "GatewayBootstrapPutResult" });

export type GatewayBootstrapPutResult = z.infer<typeof GatewayBootstrapPutResultSchema>;

export const GatewayBootstrapStatusValueSchema = z
	.object({ kind: z.literal("gateway_bootstrap_status"), pickupId: PickupIdSchema })
	.meta({ id: "GatewayBootstrapStatusValue" });

export const GatewayBootstrapStatusResultSchema = z
	.object({ held: z.boolean() })
	.meta({ id: "GatewayBootstrapStatusResult" });

/** An armed Gateway's ask, before it is a member. */
export const GatewayBootstrapAskSchema = z.object({
	pickupId: PickupIdSchema,
	gatewaySignPub: GatewayKeySchema,
	signature: b64Field().max(128),
});

export type GatewayBootstrapAsk = z.infer<typeof GatewayBootstrapAskSchema>;

/** Absent for an unknown id, another key and a bad signature alike. */
export const GatewayBootstrapAskResultSchema = z.object({ frame: GatewayBootstrapFrameSchema.optional() });

export type GatewayBootstrapAskResult = z.infer<typeof GatewayBootstrapAskResultSchema>;
