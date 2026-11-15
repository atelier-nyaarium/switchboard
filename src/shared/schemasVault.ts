import { z } from "zod";
import { ContentEnvelopeSchema } from "./schemasContentKey.js";
import { MAX_POLICY_ID_LEN } from "./schemasPolicy.js";
import { REVISION_CEILING } from "./schemasRunbook.js";

/** Router stores fields without opening them. */
export const VAULT_FIELD_NAMES = [
	"publicTitle",
	"publicDescription",
	"privateTitle",
	"privateDescription",
	"value",
	"gateways",
] as const;
export type VaultFieldName = (typeof VAULT_FIELD_NAMES)[number];

// Phone loads every entry.
export const MAX_VAULT_ENTRIES_PER_OWNER = 500;
// Bounds live entries and tombstones.
export const MAX_VAULT_RECORDS_PER_OWNER = 2_000;
export const MAX_VAULT_FIELD_B64 = 16_384;
// Long enough for every console to list once.
export const VAULT_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const entryId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[^/\r\n]+$/);
const revision = z.number().int().nonnegative();
const requestId = z.string().min(1).max(128);

export const VaultCreatedBySchema = z.enum(["phone", "gateway"]).meta({ id: "VaultCreatedBy", catalog: "createdBy" });

/** Tombstones retain identity until swept. */
export const VaultEntryClearSchema = z
	.object({
		id: entryId,
		revision: z.number().int().positive(),
		tombstone: z.boolean(),
		// Delta lists key on write revision.
		changedAt: revision,
		createdBy: VaultCreatedBySchema,
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
	})
	.meta({ id: "VaultEntryClear" });

export const VaultEntrySealedSchema = z
	.object({
		publicTitle: ContentEnvelopeSchema.optional(),
		publicDescription: ContentEnvelopeSchema.optional(),
		privateTitle: ContentEnvelopeSchema.optional(),
		privateDescription: ContentEnvelopeSchema.optional(),
		value: ContentEnvelopeSchema.optional(),
		gateways: ContentEnvelopeSchema.optional(),
	})
	.meta({ id: "VaultEntrySealed" });

export const VaultStoredEntrySchema = z
	.object({ clear: VaultEntryClearSchema, sealed: VaultEntrySealedSchema })
	.meta({ id: "VaultStoredEntry" });

export const titled = (sealed: VaultEntrySealed): boolean =>
	sealed.publicTitle !== undefined || sealed.privateTitle !== undefined;

/** 0 creates; other revisions guard updates and restores. */
export const VaultPutSchema = z
	.object({ id: entryId, expectedRevision: revision, sealed: VaultEntrySealedSchema })
	.refine((put) => titled(put.sealed), "a vault entry needs a title")
	.meta({ id: "VaultPut" });

/** Revision after write; entry is applied or winning row. */
export const VaultWriteResultSchema = z
	.object({
		outcome: z.enum(["applied", "conflict", "refused"]).meta({ id: "VaultWriteOutcome", catalog: "outcome" }),
		revision,
		entry: VaultStoredEntrySchema.optional(),
		refusal: z.string().optional(),
	})
	.meta({ id: "VaultWriteResult" });

/** Lists after `since`; zero means full, missing entries are gone. */
export const VaultListResultSchema = z
	.object({ revision, since: revision, entries: z.array(VaultStoredEntrySchema) })
	.meta({ id: "VaultListResult" });

/** Delta lists include tombstones. */
export const VaultListValueSchema = z
	.object({ kind: z.literal("vault_list"), sinceRevision: revision.optional() })
	.meta({ id: "VaultListValue" });
export const VaultPutValueSchema = z
	.object({ kind: z.literal("vault_put"), put: VaultPutSchema })
	.meta({ id: "VaultPutValue" });
export const VaultDeleteValueSchema = z
	.object({ kind: z.literal("vault_delete"), id: entryId, expectedRevision: z.number().int().positive() })
	.meta({ id: "VaultDeleteValue" });

export const VaultReadParamsSchema = z
	.object({ incarnation: z.number().int().nonnegative(), sinceRevision: revision.optional() })
	.meta({ id: "VaultReadParams" });
export const VaultCreateParamsSchema = z
	.object({ incarnation: z.number().int().nonnegative(), put: VaultPutSchema })
	.meta({ id: "VaultCreateParams" });

/** Window covers its shape for 30 minutes; session lasts until end. */
export const VaultDecisionSchema = z
	.enum(["once", "window", "session", "deny"])
	.meta({ id: "VaultDecision", catalog: "decision" });

/** Maximum displayed operation length. */
export const VAULT_OPERATION_MAX = 4096;

const operation = z.string().trim().min(1).max(VAULT_OPERATION_MAX);

/** Parent PID and start ticks reject repeated asks. */
const asker = z.string().min(1).max(128).optional();

/** Above the cap, a line stays one shape. */
export const VAULT_SHAPES_MAX = 64;

/** Window grants cover every named program. */
const shapes = z.array(z.string().min(1).max(VAULT_OPERATION_MAX)).min(1).max(VAULT_SHAPES_MAX);

/** Flag-led, it spells the whole line. */
const displayShape = z.string().min(1).max(VAULT_OPERATION_MAX);

/** Policy identity and revision used to resolve a request. */
export const VaultPolicyRefSchema = z
	.object({
		policyId: z.string().min(1).max(MAX_POLICY_ID_LEN),
		policyRevision: z.number().int().positive().max(REVISION_CEILING),
	})
	.meta({ id: "PolicyRef" });

export type PolicyRef = z.infer<typeof VaultPolicyRefSchema>;

const requestFields = {
	v: z.literal(1),
	requestId,
	operation,
	displayShape,
	coveredShapes: shapes,
	sessionTarget: z.string().min(1).max(128),
	deadlineAt: z.number().int().nonnegative(),
	asker,
};

/** Phone prompt; `typed` requests a value. */
export const VaultRequestSchema = z
	.discriminatedUnion("kind", [
		z.object({ kind: z.literal("entry"), entryId, ...requestFields, policy: VaultPolicyRefSchema.optional() }),
		z.object({ kind: z.literal("typed"), ...requestFields }),
	])
	.meta({ id: "VaultRequest" });

/** Retracts a request settled elsewhere. */
export const VaultRetractSchema = z.object({ requestId }).meta({ id: "VaultRetract" });

/** Grant holder: session, routine, or Gateway service. */
export const VaultHolderSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("session"), sessionTarget: z.string().min(1).max(128) }),
		z.strictObject({ kind: z.literal("routine"), routineId: z.string().min(1).max(64) }),
		z.strictObject({ kind: z.literal("service"), serviceId: z.string().min(1).max(64) }),
		// Remove 2026-11-28: a stored row from before services.
		z.strictObject({ kind: z.literal("watcher"), watcherId: z.string().min(1).max(64) }),
	])
	.meta({ id: "VaultHolder" });

export type VaultHolder = z.infer<typeof VaultHolderSchema>;

const grantFields = { grantId: z.string().min(1).max(128), entryId, holder: VaultHolderSchema };
const expiresAt = z.number().int().nonnegative();
/** An entry-wide grant carries none. */
const policy = VaultPolicyRefSchema.optional();

/** Reject fields that do not match the tier. */
const VaultGrantRecordSchema = z.discriminatedUnion("tier", [
	z.strictObject({
		tier: z.literal("window"),
		...grantFields,
		displayShape,
		coveredShapes: shapes,
		expiresAt,
		policy,
	}),
	z.strictObject({ tier: z.literal("session"), ...grantFields, expiresAt, policy }),
	/** Entry-wide; ends with its routine or service. */
	z.strictObject({ tier: z.literal("standing"), ...grantFields }),
]);

type VaultGrantRecord = z.infer<typeof VaultGrantRecordSchema>;

/** Sessions hold expiring grants; routines and services hold standing grants. */
function holderFitsTier(grant: VaultGrantRecord): boolean {
	return (grant.tier === "standing") === (grant.holder.kind !== "session");
}

export const VaultGrantSchema = VaultGrantRecordSchema.refine(holderFitsTier, "the holder does not fit the tier").meta({
	id: "VaultGrant",
});

export const ConsoleVaultAnswerResultSchema = z
	.object({ ok: z.boolean(), reason: z.string().optional() })
	.meta({ id: "ConsoleVaultAnswerResult" });
export const ConsoleVaultGrantsResultSchema = z
	.object({ grants: z.array(VaultGrantSchema) })
	.meta({ id: "ConsoleVaultGrantsResult" });
export const ConsoleVaultRevokeResultSchema = z
	.object({ revoked: z.boolean() })
	.meta({ id: "ConsoleVaultRevokeResult" });

// Allows overnight owner responses.
export const VAULT_REQUEST_DEADLINE_MS = 20 * 60 * 60 * 1000;
export const VAULT_WINDOW_MS = 30 * 60 * 1000;
// Whole-session grants cap at eight hours.
export const VAULT_SESSION_GRANT_CAP_MS = 8 * 60 * 60 * 1000;
export const MAX_VAULT_CAPTURE_CHARS = 8_192;
// One wait; collect again.
export const VAULT_ROUTE_WAIT_CAP_MS = 230_000;

const waitMs = z.number().int().nonnegative().optional();

/** Loopback request shapes. */
export const VaultPublicEntrySchema = z.object({
	id: entryId,
	publicTitle: z.string(),
	publicDescription: z.string().optional(),
	hasValue: z.boolean(),
});
export const VaultSearchRequestSchema = z.object({ query: z.string().max(256).optional() });
export const VaultUseRequestSchema = z.object({ entryId, operation, waitMs });
export const VaultCollectRequestSchema = z.object({ requestId, waitMs });
export const VaultWithdrawRequestSchema = z.object({ requestId });
export const VaultCaptureRequestSchema = z.object({
	publicTitle: z.string().min(1).max(256),
	publicDescription: z.string().max(2048).optional(),
	value: z.string().min(1).max(MAX_VAULT_CAPTURE_CHARS),
});
/** `asker` is absent when the helper cannot read its parent. */
export const VaultAskpassRequestSchema = z.object({ cmdline: operation, waitMs, asker });
export const VaultApprovedDecisionSchema = z.enum(["once", "window", "session", "standing"]);
/** Pending returns the request; deny and timeout refuse. */
export const VaultValueAnswerSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("approved"), decision: VaultApprovedDecisionSchema, value: z.string() }),
	z.object({ outcome: z.literal("refused"), reason: z.string(), note: z.string().max(2048).optional() }),
	z.object({ outcome: z.literal("pending"), requestId, deadlineAt: z.number().int().nonnegative() }),
]);

export type VaultEntryClear = z.infer<typeof VaultEntryClearSchema>;
export type VaultEntrySealed = z.infer<typeof VaultEntrySealedSchema>;
export type VaultStoredEntry = z.infer<typeof VaultStoredEntrySchema>;
export type VaultPut = z.infer<typeof VaultPutSchema>;
export type VaultWriteResult = z.infer<typeof VaultWriteResultSchema>;
export type VaultListResult = z.infer<typeof VaultListResultSchema>;
export type VaultDecision = z.infer<typeof VaultDecisionSchema>;
export type VaultRequest = z.infer<typeof VaultRequestSchema>;
export type VaultRetract = z.infer<typeof VaultRetractSchema>;
export type VaultGrant = z.infer<typeof VaultGrantSchema>;
export type VaultPublicEntry = z.infer<typeof VaultPublicEntrySchema>;
export type VaultApprovedDecision = z.infer<typeof VaultApprovedDecisionSchema>;
export type VaultValueAnswer = z.infer<typeof VaultValueAnswerSchema>;
