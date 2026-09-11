import { BLOB_CHUNK_BYTES } from "../../shared/router-protocol.js";
import { type BlobFetchAnswer, BlobFetchAnswerSchema } from "../../shared/schemasBlob.js";
import { openSealedBlobRange } from "../../shared/sealed-blob.js";
import type { BlobReadOutcome } from "../blobOps.js";

export interface RouterBlobReaderDeps {
	call: (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>;
	domainId: string;
	ownerSignPub: () => string | null;
	keys: { keyFor(epoch: number): Buffer | null };
}

/** Router plaintext range. */
export function createRouterBlobReader(deps: RouterBlobReaderDeps) {
	return async function read(blobId: string, offset: number, length: number): Promise<BlobReadOutcome> {
		const want = Math.min(length, BLOB_CHUNK_BYTES);
		const answer = await deps.call("blob_fetch", { blobId, range: { offset, length: want } });
		if (answer.error) return "unreachable";
		const parsed = BlobFetchAnswerSchema.safeParse(answer.result);
		if (!parsed.success) return "unreachable";
		const fetched: BlobFetchAnswer = parsed.data;
		if (fetched.outcome === "absent") return "absent";
		const owner = deps.ownerSignPub();
		const key = fetched.epoch === undefined ? null : deps.keys.keyFor(fetched.epoch);
		if (
			!owner ||
			!key ||
			fetched.epoch === undefined ||
			fetched.offset === undefined ||
			fetched.size === undefined ||
			fetched.bytes === undefined
		)
			return "unreachable";
		try {
			return openSealedBlobRange(
				{
					bytes: Buffer.from(fetched.bytes, "base64"),
					offset: fetched.offset,
					size: fetched.size,
					epoch: fetched.epoch,
				},
				offset,
				want,
				key,
				{ domainId: deps.domainId, ownerSignPub: owner, blobId },
			);
		} catch {
			return "unreachable";
		}
	};
}
