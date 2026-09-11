import { canonicalJson, sha256Hex } from "../../shared/canonical-json.js";
import {
	BLOB_CHUNK_BYTES,
	BlobBeginParamsSchema,
	BlobChunkParamsSchema,
	BlobFetchParamsSchema,
	BlobHoldParamsSchema,
} from "../../shared/router-protocol.js";
import type { BlobFetchAnswer, BlobLease } from "../../shared/schemasBlob.js";
import { landed } from "../../shared/write-result.js";
import { OwnerQuarantined } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";
import type { HeldChunk, ReferenceHeldStore } from "./referenceHeldStore.js";

const UNCERTAIN = { outcome: "refused", reason: "durability_uncertain" } as const;

/** Blob operations and staged cleanup. */
export function createBlobService(deps: { held: ReferenceHeldStore; now: () => number }) {
	const { held } = deps;
	const chunkOps = new Map<string, Map<string, { hash: string; answer: HeldChunk }>>();

	const guarded = <T>(fn: () => T): T | typeof UNCERTAIN => {
		try {
			return fn();
		} catch (error) {
			if (error instanceof OwnerQuarantined) return UNCERTAIN;
			throw error;
		}
	};

	function chunk(
		domainId: string,
		blobId: string,
		lease: BlobLease,
		offset: number,
		bytes: string,
		final: boolean,
		ledgerKey?: { opKey: string; value: unknown },
	): HeldChunk {
		const ledger = chunkOps.get(`${domainId}/${blobId}`) ?? new Map<string, { hash: string; answer: HeldChunk }>();
		const hash = ledgerKey ? sha256Hex(canonicalJson(ledgerKey.value)) : null;
		const seen = ledgerKey ? ledger.get(ledgerKey.opKey) : undefined;
		if (seen && hash !== null) return seen.hash === hash ? seen.answer : { outcome: "refused", reason: "conflict" };
		const answer = held.chunk(domainId, blobId, lease, offset, Buffer.from(bytes, "base64"), final);
		if (answer.outcome === "accepted" && answer.complete) chunkOps.delete(`${domainId}/${blobId}`);
		else if (ledgerKey && hash !== null) {
			ledger.set(ledgerKey.opKey, { hash, answer });
			chunkOps.set(`${domainId}/${blobId}`, ledger);
		}
		return answer;
	}

	function fetch(domainId: string, blobId: string, range?: { offset: number; length: number }): BlobFetchAnswer {
		const answer = held.read(domainId, blobId, range?.offset ?? 0, range?.length ?? BLOB_CHUNK_BYTES);
		if (answer.outcome === "absent") return { outcome: "absent" };
		return {
			outcome: "fetched",
			bytes: answer.bytes.toString("base64"),
			eof: answer.eof,
			epoch: answer.epoch,
			offset: answer.offset,
			size: answer.size,
		};
	}

	return {
		register(hooks: OwnerServiceHooks) {
			hooks.ownerOp("blob_begin", (op, value) =>
				guarded(() => {
					chunkOps.delete(`${op.domainId}/${value.blobId}`);
					return held.begin(op.domainId, value);
				}),
			);
			hooks.ownerOp("blob_chunk", (op, value) =>
				guarded(() =>
					chunk(op.domainId, value.blobId, value.lease, value.offset, value.bytes, value.final, {
						opKey: `${op.conversationId}/${op.opId}`,
						value,
					}),
				),
			);
			hooks.ownerOp("blob_upload_status", (op, value) => guarded(() => held.status(op.domainId, value.blobId)));
			hooks.ownerOp("blob_fetch", (op, value) => guarded(() => fetch(op.domainId, value.blobId, value.range)));

			hooks.gatewayFrame("blob_begin", "value", (reg, params) => {
				const parsed = BlobBeginParamsSchema.safeParse(params);
				if (!parsed.success) return { ok: false, error: "invalid blob_begin" };
				return guarded(() => held.begin(reg.domainId, parsed.data));
			});
			hooks.gatewayFrame("blob_chunk", "value", (reg, params) => {
				const parsed = BlobChunkParamsSchema.safeParse(params);
				if (!parsed.success) return { ok: false, error: "invalid blob_chunk" };
				const { blobId, lease, offset, bytes, final } = parsed.data;
				return guarded(() => chunk(reg.domainId, blobId, lease, offset, bytes, final));
			});
			hooks.gatewayFrame("blob_hold", "value", (reg, params) => {
				const parsed = BlobHoldParamsSchema.safeParse(params);
				if (!parsed.success) return { ok: false, error: "invalid blob_hold" };
				return guarded(() => {
					const ref = { kind: "hold" as const, gatewayId: reg.gatewayId, holdId: parsed.data.holdId };
					const set = { ref, blobIds: [parsed.data.blobId], expiresAt: deps.now() + parsed.data.ttlMs };
					const write = held.publish(reg.domainId, [set], () => {});
					if (landed(write)) return { outcome: "accepted" };
					return { outcome: "refused", reason: write.kind };
				});
			});
			hooks.gatewayFrame("blob_fetch", "read", (reg, params) => {
				const parsed = BlobFetchParamsSchema.safeParse(params);
				if (!parsed.success) return { ok: false, error: "invalid blob_fetch" };
				return guarded(() => fetch(reg.domainId, parsed.data.blobId, parsed.data.range));
			});
			hooks.onSweep("held blob sweep", (domainId, now) => held.sweep(domainId, now));
		},
	};
}
