import { z } from "zod";
import type { BlobStore } from "../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, MAX_BLOB_BYTES } from "../shared/router-protocol.js";
import { BlobIdField } from "../shared/schemasBlob.js";

////////////////////////////////
//  Interfaces & Types

/** Loopback blob access. */
export const BlobStatOpSchema = z.object({ kind: z.literal("blob_stat"), blobId: BlobIdField });
export const BlobPutOpSchema = z.object({
	kind: z.literal("blob_put"),
	blobId: BlobIdField,
	offset: z.number().int().nonnegative(),
	chunk: z.string().max(BLOB_CHUNK_BYTES * 2),
	final: z.boolean(),
});
export const BlobGetOpSchema = z.object({
	kind: z.literal("blob_get"),
	blobId: BlobIdField,
	offset: z.number().int().nonnegative(),
	length: z.number().int().positive().max(BLOB_CHUNK_BYTES),
});

export type BlobOp =
	| z.infer<typeof BlobStatOpSchema>
	| z.infer<typeof BlobPutOpSchema>
	| z.infer<typeof BlobGetOpSchema>;

/** Router range result. */
export type BlobReadOutcome = { bytes: Buffer; eof: boolean } | "absent" | "unreachable";
export type BlobReader = (blobId: string, offset: number, length: number) => Promise<BlobReadOutcome>;

export type BlobOpResult = { have: number; complete: boolean } | { chunk?: string; eof: boolean; absent?: boolean };

/** Signals an oversized put. */
export class BlobTooLarge extends Error {}

////////////////////////////////
//  Functions & Helpers

/**
 * Answer one blob op. A stat and a put touch this Gateway's staging only. A get reads staging when
 * the bytes are here, else the Router, which is the one holder once anything published them.
 */
export async function answerBlobOp(store: BlobStore, op: BlobOp, read: BlobReader): Promise<BlobOpResult> {
	switch (op.kind) {
		case "blob_stat":
			return store.stat(op.blobId);

		case "blob_put": {
			const chunk = Buffer.from(op.chunk, "base64");
			if (chunk.length > BLOB_CHUNK_BYTES) {
				throw new BlobTooLarge(`chunk of ${chunk.length} bytes exceeds ${BLOB_CHUNK_BYTES}`);
			}
			if (op.offset + chunk.length > MAX_BLOB_BYTES) {
				throw new BlobTooLarge(`blob would reach ${op.offset + chunk.length} bytes, over ${MAX_BLOB_BYTES}`);
			}
			return store.write(op.blobId, op.offset, chunk, op.final);
		}

		case "blob_get": {
			const want = Math.min(op.length, BLOB_CHUNK_BYTES);
			if (store.path(op.blobId)) {
				const r = store.read(op.blobId, op.offset, want);
				return { ...(r.bytes.length > 0 ? { chunk: r.bytes.toString("base64") } : {}), eof: r.eof };
			}
			const fetched = await read(op.blobId, op.offset, want);
			if (fetched === "absent") return { eof: false, absent: true };
			if (fetched === "unreachable") throw new Error(`blob ${op.blobId} is not reachable on the Router`);
			return {
				...(fetched.bytes.length > 0 ? { chunk: fetched.bytes.toString("base64") } : {}),
				eof: fetched.eof,
			};
		}
	}
}
