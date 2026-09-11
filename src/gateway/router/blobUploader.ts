import crypto from "node:crypto";
import type { BlobStore } from "../../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, BLOB_CIPHERTEXT_CHUNK_BYTES } from "../../shared/router-protocol.js";
import { BlobBeginAnswerSchema, BlobChunkAnswerSchema } from "../../shared/schemasBlob.js";
import { sealBlobChunk, sealedBlobChunkCount, sealedBlobSize } from "../../shared/sealed-blob.js";

export interface BlobUploaderDeps {
	call: (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>;
	blobs: Pick<BlobStore, "stat" | "read">;
	incarnation: () => number | null;
	domainId: string;
	ownerSignPub: () => string | null;
	keys: {
		epochs(): number[];
		keyFor(epoch: number): Buffer | null;
	};
}

/** The one hold id for a scope and a blob. */
export function holdIdFor(scope: string, blobId: string): string {
	return crypto.createHash("sha256").update(`${scope}/${blobId}`).digest("hex");
}

export type StageOutcome =
	| { kind: "staged" }
	| { kind: "already_held" }
	| { kind: "absent" }
	| { kind: "failed"; error: string };

/** Uploads staged plaintext. */
export function createBlobUploader(deps: BlobUploaderDeps) {
	async function stage(blobId: string): Promise<StageOutcome> {
		if (deps.incarnation() === null) return { kind: "failed", error: "Gateway is not registered" };
		const stat = deps.blobs.stat(blobId);
		if (!stat.complete || stat.size === undefined) return { kind: "absent" };
		const size = stat.size;
		const ownerSignPub = deps.ownerSignPub();
		const epoch = deps.keys.epochs().at(-1);
		const key = epoch === undefined ? null : deps.keys.keyFor(epoch);
		if (!ownerSignPub || epoch === undefined || !key)
			return { kind: "failed", error: "Content key is unavailable" };
		const context = { domainId: deps.domainId, ownerSignPub, epoch, blobId };
		const chunks = sealedBlobChunkCount(size);
		const hash = crypto.createHash("sha256");
		const frame = (index: number): Buffer => {
			const offset = index * BLOB_CHUNK_BYTES;
			const length = Math.min(BLOB_CHUNK_BYTES, size - offset);
			const read = length === 0 ? { bytes: Buffer.alloc(0) } : deps.blobs.read(blobId, offset, length);
			return sealBlobChunk(read.bytes, key, context, index, index + 1 === chunks);
		};
		for (let index = 0; index < chunks; index++) hash.update(frame(index));
		const begun = await deps.call("blob_begin", {
			blobId,
			size,
			ciphertextSize: sealedBlobSize(size),
			ciphertextDigest: `sha256-${hash.digest("hex")}`,
			epoch,
		});
		if (begun.error) return { kind: "failed", error: begun.error };
		const answer = BlobBeginAnswerSchema.safeParse(begun.result);
		if (!answer.success) return { kind: "failed", error: "begin unparsed" };
		if (answer.data.outcome === "complete") return { kind: "already_held" };
		if (answer.data.outcome !== "lease" || !answer.data.lease)
			return { kind: "failed", error: answer.data.reason ?? "begin refused" };
		const lease = answer.data.lease;
		for (let index = Math.floor((answer.data.have ?? 0) / BLOB_CIPHERTEXT_CHUNK_BYTES); index < chunks; index++) {
			const final = index + 1 === chunks;
			const sent = await deps.call("blob_chunk", {
				blobId,
				lease,
				offset: index * BLOB_CIPHERTEXT_CHUNK_BYTES,
				bytes: frame(index).toString("base64"),
				final,
			});
			if (sent.error) return { kind: "failed", error: sent.error };
			const chunkAnswer = BlobChunkAnswerSchema.safeParse(sent.result);
			if (!chunkAnswer.success) return { kind: "failed", error: "chunk unparsed" };
			if (chunkAnswer.data.outcome !== "accepted")
				return { kind: "failed", error: chunkAnswer.data.reason ?? "chunk refused" };
			if (final && chunkAnswer.data.complete !== true) return { kind: "failed", error: "ciphertext_unverified" };
		}
		return { kind: "staged" };
	}

	/** Router-held blob ids. */
	async function stageAll(blobIds: readonly string[]): Promise<string[]> {
		const held: string[] = [];
		for (const blobId of blobIds) {
			const outcome = await stage(blobId);
			if (outcome.kind === "staged" || outcome.kind === "already_held") held.push(blobId);
			else if (outcome.kind === "failed") console.warn(`[blob-stage] ${blobId}: ${outcome.error}`);
		}
		return held;
	}

	/** A time-bound reference under this Gateway's name, for bytes no record names yet. */
	async function hold(blobId: string, holdId: string, ttlMs: number): Promise<boolean> {
		const answer = await deps.call("blob_hold", { blobId, holdId, ttlMs });
		return !answer.error && (answer.result as { outcome?: string } | undefined)?.outcome === "accepted";
	}

	return { stage, stageAll, hold };
}
