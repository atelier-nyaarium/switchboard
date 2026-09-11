import { z } from "zod";
import { BLOB_CIPHERTEXT_CHUNK_BYTES, MAX_BLOB_BYTES, MAX_BLOB_CIPHERTEXT_BYTES } from "./router-protocol.js";

////////////////////////////////

/** Plaintext digest identifier. */
export const BlobIdField = z.string().regex(/^sha256-[0-9a-f]{64}$/);

const rangeField = z
	.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive() })
	.meta({ id: "BlobRange" });

export const BlobLeaseSchema = z
	.object({ id: z.string().min(1), generation: z.number().int().positive() })
	.meta({ id: "BlobLease" });

/** Declared blob metadata. */
export const BlobDeclarationSchema = z.object({
	blobId: BlobIdField,
	size: z.number().int().nonnegative().max(MAX_BLOB_BYTES),
	ciphertextSize: z.number().int().positive().max(MAX_BLOB_CIPHERTEXT_BYTES),
	ciphertextDigest: BlobIdField,
	epoch: z.number().int().min(1).max(2147483647),
});

export const BlobBeginValueSchema = BlobDeclarationSchema.extend({ kind: z.literal("blob_begin") }).meta({
	id: "BlobBeginValue",
});

export const BlobChunkValueSchema = z
	.object({
		kind: z.literal("blob_chunk"),
		blobId: BlobIdField,
		lease: BlobLeaseSchema,
		offset: z.number().int().nonnegative(),
		bytes: z.string().max(BLOB_CIPHERTEXT_CHUNK_BYTES * 2),
		final: z.boolean(),
	})
	.meta({ id: "BlobChunkValue" });

export const BlobUploadStatusValueSchema = z
	.object({ kind: z.literal("blob_upload_status"), blobId: BlobIdField })
	.meta({ id: "BlobUploadStatusValue" });

export const BlobFetchValueSchema = z
	.object({ kind: z.literal("blob_fetch"), blobId: BlobIdField, range: rangeField.optional() })
	.meta({ id: "BlobFetchValue" });

export const BlobBeginAnswerSchema = z
	.object({
		outcome: z.enum(["lease", "complete", "refused"]),
		lease: BlobLeaseSchema.optional(),
		have: z.number().int().nonnegative().optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "BlobBeginAnswer" });

export const BlobChunkAnswerSchema = z
	.object({
		outcome: z.enum(["accepted", "refused"]),
		have: z.number().int().nonnegative().optional(),
		complete: z.boolean().optional(),
		reason: z.string().optional(),
	})
	.meta({ id: "BlobChunkAnswer" });

export const BlobUploadStatusAnswerSchema = z
	.object({
		outcome: z.enum(["absent", "staged", "complete"]),
		have: z.number().int().nonnegative().optional(),
		lease: BlobLeaseSchema.optional(),
		size: z.number().int().nonnegative().optional(),
		ciphertextSize: z.number().int().nonnegative().optional(),
		ciphertextDigest: z.string().optional(),
		epoch: z.number().int().optional(),
	})
	.meta({ id: "BlobUploadStatusAnswer" });

export const BlobFetchAnswerSchema = z
	.object({
		outcome: z.enum(["fetched", "absent"]),
		bytes: z.string().optional(),
		eof: z.boolean().optional(),
		epoch: z.number().int().optional(),
		offset: z.number().int().nonnegative().optional(),
		size: z.number().int().nonnegative().optional(),
	})
	.meta({ id: "BlobFetchAnswer" });

export { ChannelFileSchema, ChannelFilesSchema } from "./channel-file.js";

export type BlobLease = z.infer<typeof BlobLeaseSchema>;
export type BlobDeclaration = z.infer<typeof BlobDeclarationSchema>;
export type BlobBeginAnswer = z.infer<typeof BlobBeginAnswerSchema>;
export type BlobChunkAnswer = z.infer<typeof BlobChunkAnswerSchema>;
export type BlobUploadStatusAnswer = z.infer<typeof BlobUploadStatusAnswerSchema>;
export type BlobFetchAnswer = z.infer<typeof BlobFetchAnswerSchema>;
