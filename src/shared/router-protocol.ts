import { z } from "zod";

// Relay payloads stay opaque here.

export const BLOB_CHUNK_BYTES = 1_048_576;

export const BLOB_NONCE_BYTES = 12;
export const BLOB_TAG_BYTES = 16;
export const BLOB_FRAME_OVERHEAD_BYTES = BLOB_NONCE_BYTES + BLOB_TAG_BYTES;

export const BLOB_CIPHERTEXT_CHUNK_BYTES = BLOB_CHUNK_BYTES + BLOB_FRAME_OVERHEAD_BYTES;

// Enforce blob limits on received bytes.
export const MAX_BLOB_BYTES = 500_000_000;
export const MAX_BLOB_CIPHERTEXT_BYTES =
	MAX_BLOB_BYTES + Math.ceil(MAX_BLOB_BYTES / BLOB_CHUNK_BYTES) * BLOB_FRAME_OVERHEAD_BYTES;

export const MAX_RELAY_FRAME_BYTES = 8_000_000;

export const ValueOpFrameSchema = z.object({
	type: z.literal("value_op"),
	opId: z.string().min(1),
	conversationId: z.string().min(1),
	signerSignPub: z.string().min(1),
	device: z.string().min(1),
	value: z.unknown(),
	incarnation: z.number().int().positive(),
});

export const RouterInboundFrameSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("tool_result"),
		callId: z.string(),
		result: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("tool_error"),
		callId: z.string().nullable(),
		error: z.string().optional(),
	}),
	z.looseObject({
		type: z.literal("gateway_relay"),
	}),
	z.looseObject({
		type: z.literal("cross_domain_handshake"),
	}),
	z.looseObject({
		type: z.literal("cross_domain_handshake_reveal"),
	}),
	z.object({
		type: z.literal("domain_update"),
		domain: z.unknown(),
		version: z.string().optional(),
		displayName: z.string().nullish(),
	}),
	z.object({
		type: z.literal("inbox_deliver"),
		address: z.string(),
		rows: z.unknown(),
		incarnation: z.number().int().positive(),
		deliveryEpoch: z.number().int().positive(),
	}),
	ValueOpFrameSchema,
	z.object({
		type: z.literal("presence_resync"),
		incarnation: z.number().int().positive(),
	}),
	z.object({
		type: z.literal("unlink"),
		domainId: z.string().min(1),
		incarnation: z.number().int().positive(),
	}),
]);

export const ToolCallFrameSchema = z.object({
	type: z.literal("tool_call"),
	callId: z.string().min(1),
	action: z.string().min(1),
	params: z.record(z.string(), z.unknown()),
});

export const InboxAppendParamsSchema = z.object({
	address: z.string(),
	row: z.unknown(),
	opKey: z.unknown().optional(),
	incarnation: z.number().int().positive(),
});

export const InboxAckParamsSchema = z.object({
	address: z.string(),
	seq: z.number().int().min(1),
	incarnation: z.number().int().positive(),
	deliveryEpoch: z.number().int().positive(),
	outcome: z.enum(["delivered", "waking", "failed"]),
	reason: z.string().optional(),
});

export const SessionUpsertParamsSchema = z.object({
	sessionId: z.string(),
	kind: z.string(),
	label: z.string(),
	recordExists: z.boolean(),
	incarnation: z.number().int().positive(),
});

export const SessionForgetParamsSchema = z.object({
	sessionId: z.string(),
	incarnation: z.number().int().positive(),
});

const blobIdField = z.string().regex(/^sha256-[0-9a-f]{64}$/);

// Avoids importing schemasBlob.ts.
export const BlobFetchParamsSchema = z.object({
	blobId: blobIdField,
	range: z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() }).optional(),
	incarnation: z.number().int().positive(),
});

export const BlobBeginParamsSchema = z.object({
	blobId: blobIdField,
	size: z.number().int().nonnegative().max(MAX_BLOB_BYTES),
	ciphertextSize: z.number().int().positive().max(MAX_BLOB_CIPHERTEXT_BYTES),
	ciphertextDigest: blobIdField,
	epoch: z.number().int().min(1).max(2147483647),
	incarnation: z.number().int().positive(),
});

export const BlobChunkParamsSchema = z.object({
	blobId: blobIdField,
	lease: z.object({ id: z.string().min(1), generation: z.number().int().positive() }),
	offset: z.number().int().nonnegative(),
	bytes: z.string().max(BLOB_CIPHERTEXT_CHUNK_BYTES * 2),
	final: z.boolean(),
	incarnation: z.number().int().positive(),
});

export const BLOB_HOLD_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** Temporary reference for relayed bytes. */
export const BlobHoldParamsSchema = z.object({
	blobId: blobIdField,
	holdId: z.string().min(1).max(128),
	ttlMs: z.number().int().positive().max(BLOB_HOLD_MAX_MS),
	incarnation: z.number().int().positive(),
});

// The call carries the name; a `type` field here would refuse every gateway answer.
export const ValueResultParamsSchema = z.object({
	opId: z.string().min(1),
	conversationId: z.string().min(1),
	result: z.unknown(),
	incarnation: z.number().int().positive(),
});

export const FEDERATION_PROTOCOL_FLOOR = 1;
export const FEDERATION_PROTOCOL_VERSION = 2;
export const FEDERATION_VALUE_PROTOCOL_VERSION = FEDERATION_PROTOCOL_VERSION;

export const GatewayRegisterParamsSchema = z.object({
	gatewayId: z.string().min(1).max(64),
	domainId: z.string().min(1).max(64).optional(),
	protocolVersion: z.number().int().positive(),
	signPub: z.string().min(1).optional(),
	boxPub: z.string().min(1).optional(),
	admission: z.string().min(1).optional(),
	proof: z.string().min(1).optional(),
	proofAt: z.number().int().nonnegative().optional(),
	proofNonce: z.string().min(1).optional(),
});

export const GatewayRelayRouteSchema = z.object({
	relayId: z.string().min(1).max(128),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	// Optional wire field, always stamped by Router.
	srcDomain: z.string().min(1).max(64).optional(),
	// Destination parses and unseals it.
	payload: z.unknown(),
});

export const GatewayRelayReplyParamsSchema = z.object({
	relayId: z.string().min(1).max(128),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

export const CrossDomainHandshakeRouteSchema = z.object({
	handshakeId: z.string().min(1).max(128),
	srcDomain: z.string().min(1).max(64),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	// Commitment payload remains opaque.
	payload: z.unknown(),
});

export const CrossDomainHandshakeReplyParamsSchema = z.object({
	handshakeId: z.string().min(1).max(128),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

export const CrossDomainHandshakeRevealRouteSchema = z.object({
	handshakeId: z.string().min(1).max(128),
	srcDomain: z.string().min(1).max(64),
	srcGateway: z.string().min(1).max(64),
	dstGateway: z.string().min(1).max(64),
	// Reveal payload remains opaque.
	payload: z.unknown(),
});

export const CrossDomainHandshakeRevealReplyParamsSchema = z.object({
	handshakeId: z.string().min(1).max(128),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

export type RouterInboundFrame = z.infer<typeof RouterInboundFrameSchema>;
export type ToolCallFrame = z.infer<typeof ToolCallFrameSchema>;
export type InboxAppendParams = z.infer<typeof InboxAppendParamsSchema>;
export type InboxAckParams = z.infer<typeof InboxAckParamsSchema>;
export type SessionUpsertParams = z.infer<typeof SessionUpsertParamsSchema>;
export type SessionForgetParams = z.infer<typeof SessionForgetParamsSchema>;
export type BlobFetchParams = z.infer<typeof BlobFetchParamsSchema>;
export type BlobBeginParams = z.infer<typeof BlobBeginParamsSchema>;
export type BlobChunkParams = z.infer<typeof BlobChunkParamsSchema>;
export type BlobHoldParams = z.infer<typeof BlobHoldParamsSchema>;
export type GatewayRegisterParams = z.infer<typeof GatewayRegisterParamsSchema>;
export type GatewayRelayRoute = z.infer<typeof GatewayRelayRouteSchema>;
export type GatewayRelayReplyParams = z.infer<typeof GatewayRelayReplyParamsSchema>;
export type CrossDomainHandshakeRoute = z.infer<typeof CrossDomainHandshakeRouteSchema>;
export type CrossDomainHandshakeReplyParams = z.infer<typeof CrossDomainHandshakeReplyParamsSchema>;
export type CrossDomainHandshakeRevealRoute = z.infer<typeof CrossDomainHandshakeRevealRouteSchema>;
export type CrossDomainHandshakeRevealReplyParams = z.infer<typeof CrossDomainHandshakeRevealReplyParamsSchema>;
