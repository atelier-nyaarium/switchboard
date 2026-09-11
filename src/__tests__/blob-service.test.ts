import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlobService } from "../federation-server/blobs/blobService.js";
import { ReferenceHeldStore, STAGED_BLOB_TTL_MS } from "../federation-server/blobs/referenceHeldStore.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import type { GatewayRegistration, OwnerServiceHooks } from "../federation-server/ownerServiceHooks.js";
import { blobIdFor } from "../shared/blob-store.js";
import { generateIdentity } from "../shared/crypto.js";
import { BLOB_CHUNK_BYTES, BLOB_CIPHERTEXT_CHUNK_BYTES } from "../shared/router-protocol.js";
import type { OwnerOp } from "../shared/schemasInbox.js";
import { openSealedBlobRange, sealBlobChunk, sealedBlobSize } from "../shared/sealed-blob.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const DOMAIN = "domain";
const key = Buffer.alloc(32, 9);
const reg: GatewayRegistration = { domainId: DOMAIN, gatewayId: "gateway", signPub: "pub", incarnation: 1 };

function make() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "blob-service-"));
	roots.push(root);
	let now = 10_000;
	const owner = generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir: root,
		ownerOf: (domainId) => (domainId === DOMAIN ? owner.sign.pub : null),
		quotaFor: () =>
			new DomainQuota({ dir: root, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => now },
	});
	const held = new ReferenceHeldStore({
		dataDir: root,
		registry,
		ambient: { now: () => now, newId: () => crypto.randomUUID() },
	});
	const ownerOps = new Map<string, (op: OwnerOp, value: Record<string, unknown>) => unknown>();
	const frames = new Map<string, (reg: GatewayRegistration, params: Record<string, unknown>) => unknown>();
	const sweeps: Array<(domainId: string, now: number) => void> = [];
	const hooks = {
		ownerOp: (kind, handler) => ownerOps.set(kind, handler as never),
		gatewayFrame: (name, _mutation, handler) => frames.set(name, handler as never),
		onSweep: (_label, sweep) => sweeps.push(sweep),
		onGatewayRegistered: () => undefined,
		onGatewayDropped: () => undefined,
		onSessionForgotten: () => undefined,
		pushFrameTo: () => false,
		gatewayIncarnation: () => null,
		connectedGateways: () => [],
	} satisfies OwnerServiceHooks;
	createBlobService({ held, now: () => now }).register(hooks);
	let opCounter = 0;
	const owned = async (kind: string, value: Record<string, unknown>, opId = `op-${++opCounter}`) =>
		ownerOps.get(kind)?.({ domainId: DOMAIN, conversationId: "conv", opId, device: "phone" } as OwnerOp, {
			kind,
			...value,
		});
	const frame = async (name: string, params: Record<string, unknown>) =>
		frames.get(name)?.(reg, { incarnation: 1, ...params });
	return { held, owned, frame, sweeps, setNow: (value: number) => (now = value), now: () => now };
}

function seal(plain: Buffer, epoch = 1) {
	const blobId = blobIdFor(plain);
	const chunks = Math.max(1, Math.ceil(plain.length / BLOB_CHUNK_BYTES));
	const frames: Buffer[] = [];
	for (let index = 0; index < chunks; index++) {
		const slice = plain.subarray(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES);
		frames.push(
			sealBlobChunk(
				slice,
				key,
				{ domainId: DOMAIN, ownerSignPub: "owner", epoch, blobId },
				index,
				index + 1 === chunks,
			),
		);
	}
	const digest = `sha256-${crypto.createHash("sha256").update(Buffer.concat(frames)).digest("hex")}`;
	return {
		blobId,
		frames,
		declared: {
			blobId,
			size: plain.length,
			ciphertextSize: sealedBlobSize(plain.length),
			ciphertextDigest: digest,
			epoch,
		},
	};
}

describe("blob service", () => {
	it("the phone stages a blob by owner op, checks it, and reads it back as the sealed range it sent", async () => {
		const { owned } = make();
		const plain = Buffer.from("owner bytes");
		const blob = seal(plain);
		expect(await owned("blob_upload_status", { blobId: blob.blobId })).toEqual({ outcome: "absent" });
		const begun = (await owned("blob_begin", blob.declared)) as { outcome: string; lease: unknown; have: number };
		expect(begun).toMatchObject({ outcome: "lease", have: 0 });
		expect(
			await owned("blob_chunk", {
				blobId: blob.blobId,
				lease: begun.lease,
				offset: 0,
				bytes: blob.frames[0].toString("base64"),
				final: true,
			}),
		).toEqual({ outcome: "accepted", have: blob.frames[0].length, complete: true });
		expect(await owned("blob_upload_status", { blobId: blob.blobId })).toMatchObject({
			outcome: "complete",
			size: plain.length,
			epoch: 1,
		});
		const fetched = (await owned("blob_fetch", { blobId: blob.blobId, range: { offset: 2, length: 4 } })) as {
			outcome: string;
			bytes: string;
			eof: boolean;
			epoch: number;
			offset: number;
			size: number;
		};
		expect(fetched).toMatchObject({ outcome: "fetched", epoch: 1, offset: 0, size: plain.length, eof: false });
		const opened = openSealedBlobRange(
			{
				bytes: Buffer.from(fetched.bytes, "base64"),
				offset: fetched.offset,
				size: fetched.size,
				epoch: fetched.epoch,
			},
			2,
			4,
			key,
			{ domainId: DOMAIN, ownerSignPub: "owner", blobId: blob.blobId },
		);
		expect(opened.bytes).toEqual(Buffer.from("ner "));
	});

	it("a repeated chunk op replays its answer, and the same op with another body is a conflict", async () => {
		const { owned } = make();
		const blob = seal(Buffer.alloc(BLOB_CHUNK_BYTES + 5, 7));
		const begun = (await owned("blob_begin", blob.declared)) as { lease: unknown };
		const first = {
			blobId: blob.blobId,
			lease: begun.lease,
			offset: 0,
			bytes: blob.frames[0].toString("base64"),
			final: false,
		};
		expect(await owned("blob_chunk", first, "chunk-0")).toEqual({
			outcome: "accepted",
			have: blob.frames[0].length,
			complete: false,
		});
		expect(await owned("blob_chunk", first, "chunk-0")).toEqual({
			outcome: "accepted",
			have: blob.frames[0].length,
			complete: false,
		});
		const forged = Buffer.from(blob.frames[0]);
		forged[10] ^= 1;
		expect(await owned("blob_chunk", { ...first, bytes: forged.toString("base64") }, "chunk-0")).toEqual({
			outcome: "refused",
			reason: "conflict",
		});
		expect(
			await owned(
				"blob_chunk",
				{
					blobId: blob.blobId,
					lease: begun.lease,
					offset: BLOB_CIPHERTEXT_CHUNK_BYTES,
					bytes: blob.frames[1].toString("base64"),
					final: true,
				},
				"chunk-1",
			),
		).toMatchObject({ outcome: "accepted", complete: true });
	});

	it("a gateway stages, holds, and reads through frames; the hold expires on the sweep", async () => {
		const { held, frame, sweeps, setNow, now } = make();
		const blob = seal(Buffer.from("relayed"));
		const begun = (await frame("blob_begin", blob.declared)) as { outcome: string; lease: unknown };
		expect(begun.outcome).toBe("lease");
		await frame("blob_chunk", {
			blobId: blob.blobId,
			lease: begun.lease,
			offset: 0,
			bytes: blob.frames[0].toString("base64"),
			final: true,
		});
		expect(await frame("blob_hold", { blobId: blob.blobId, holdId: "relay-1", ttlMs: 5_000 })).toEqual({
			outcome: "accepted",
		});
		expect(held.refs(DOMAIN, blob.blobId)).toEqual([{ kind: "hold", gatewayId: "gateway", holdId: "relay-1" }]);
		expect(await frame("blob_fetch", { blobId: blob.blobId })).toMatchObject({ outcome: "fetched", size: 7 });
		setNow(now() + STAGED_BLOB_TTL_MS + 1);
		for (const sweep of sweeps) sweep(DOMAIN, now());
		expect(held.has(DOMAIN, blob.blobId)).toBe(false);
		expect(await frame("blob_fetch", { blobId: blob.blobId })).toEqual({ outcome: "absent" });
		expect(await frame("blob_hold", { blobId: blob.blobId, holdId: "relay-2", ttlMs: 5_000 })).toEqual({
			outcome: "refused",
			reason: "blob_missing",
		});
	});

	it("a fetch of bytes still landing answers absent", async () => {
		const { owned } = make();
		const blob = seal(Buffer.alloc(BLOB_CHUNK_BYTES + 5, 3));
		const begun = (await owned("blob_begin", blob.declared)) as { lease: unknown };
		await owned("blob_chunk", {
			blobId: blob.blobId,
			lease: begun.lease,
			offset: 0,
			bytes: blob.frames[0].toString("base64"),
			final: false,
		});
		expect(await owned("blob_fetch", { blobId: blob.blobId })).toEqual({ outcome: "absent" });
		expect(await owned("blob_upload_status", { blobId: blob.blobId })).toMatchObject({
			outcome: "staged",
			have: blob.frames[0].length,
		});
	});
});
