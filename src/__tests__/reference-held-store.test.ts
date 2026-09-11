import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReferenceHeldStore, STAGED_BLOB_TTL_MS } from "../federation-server/blobs/referenceHeldStore.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import type { BlobReference } from "../shared/blob-reference.js";
import { blobIdFor } from "../shared/blob-store.js";
import { generateIdentity } from "../shared/crypto.js";
import { sealBlobChunk, sealedBlobSize } from "../shared/sealed-blob.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const DOMAIN = "domain";
const entry: BlobReference = { kind: "entry", entryId: "entry-1" };
const row: BlobReference = {
	kind: "row",
	address: { kind: "gateway", domainId: DOMAIN, gatewayId: "gateway" },
	seq: 1,
};

interface Seed {
	root: string;
	owner: ReturnType<typeof generateIdentity>;
	now: () => number;
}

/** Reopens persisted state. */
function make(options: { quota?: number; from?: Seed } = {}) {
	const root = options.from?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "held-blobs-"));
	if (!options.from) roots.push(root);
	let now = options.from?.now() ?? 1_000;
	const owner = options.from?.owner ?? generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir: root,
		ownerOf: (domainId) => (domainId === DOMAIN ? owner.sign.pub : null),
		quotaFor: () =>
			new DomainQuota({ dir: root, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => now },
	});
	const store = new ReferenceHeldStore({
		dataDir: root,
		registry,
		quotaBytesPerDomain: options.quota,
		ambient: { now: () => now, newId: () => crypto.randomUUID() },
	});
	return { root, owner, registry, store, setNow: (value: number) => (now = value), now: () => now };
}

function sealed(plain: Buffer, epoch = 1) {
	const blobId = blobIdFor(plain);
	const bytes = sealBlobChunk(
		plain,
		Buffer.alloc(32, 4),
		{ domainId: DOMAIN, ownerSignPub: "owner", epoch, blobId },
		0,
		true,
	);
	const digest = `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
	return {
		blobId,
		bytes,
		declared: { blobId, size: plain.length, ciphertextSize: bytes.length, ciphertextDigest: digest, epoch },
	};
}

function stage(store: ReferenceHeldStore, blob: ReturnType<typeof sealed>) {
	const begun = store.begin(DOMAIN, blob.declared);
	if (begun.outcome !== "lease") throw new Error(`expected a lease, got ${begun.outcome}`);
	const sent = store.chunk(DOMAIN, blob.blobId, begun.lease, 0, blob.bytes, true);
	expect(sent).toEqual({ outcome: "accepted", have: blob.bytes.length, complete: true });
	return begun.lease;
}

describe("ReferenceHeldStore", () => {
	it("keeps verified bytes until the last reference is released, and refuses a record that names a blob it does not hold", () => {
		const { store, registry } = make();
		const blob = sealed(Buffer.from("held bytes"));
		expect(store.publish(DOMAIN, [{ ref: entry, blobIds: [blob.blobId] }], () => {})).toEqual({
			kind: "blob_missing",
			blobId: blob.blobId,
		});
		stage(store, blob);
		let mutated = 0;
		expect(
			store.publish(
				DOMAIN,
				[
					{ ref: entry, blobIds: [blob.blobId] },
					{ ref: row, blobIds: [blob.blobId], expiresAt: 5_000 },
				],
				(tx) => {
					mutated++;
					tx.put("board.meta", "probe", null, { clear: { revision: 1 } });
				},
			),
		).toMatchObject({ kind: "ok" });
		expect(mutated).toBe(1);
		expect(registry.for(DOMAIN).get("board.meta", "probe")).not.toBeNull();
		expect(store.has(DOMAIN, blob.blobId)).toBe(true);
		expect(store.refs(DOMAIN, blob.blobId)).toEqual([entry, row]);
		expect(store.publish(DOMAIN, [{ ref: entry, blobIds: [] }], () => {})).toMatchObject({ kind: "ok" });
		expect(store.has(DOMAIN, blob.blobId)).toBe(true);
		expect(store.publish(DOMAIN, [{ ref: row, blobIds: [] }], () => {})).toMatchObject({ kind: "ok" });
		expect(store.has(DOMAIN, blob.blobId)).toBe(false);
		expect(store.status(DOMAIN, blob.blobId)).toEqual({ outcome: "absent" });
	});

	it("a refused mutation writes nothing, not even the references", () => {
		const { store, registry } = make();
		const blob = sealed(Buffer.from("conflict"));
		stage(store, blob);
		registry.for(DOMAIN).put("board.meta", "probe", null, { clear: { revision: 1 } });
		const write = store.publish(DOMAIN, [{ ref: entry, blobIds: [blob.blobId] }], (tx) =>
			tx.put("board.meta", "probe", null, { clear: { revision: 2 } }),
		);
		expect(write.kind).toBe("conflict");
		expect(store.refs(DOMAIN, blob.blobId)).toEqual([]);
		expect(store.has(DOMAIN, blob.blobId)).toBe(true);
	});

	it("an unpublished blob lives an hour past its last chunk, then the sweep drops it", () => {
		const { store, setNow, now } = make();
		const blob = sealed(Buffer.from("staged"));
		stage(store, blob);
		setNow(now() + STAGED_BLOB_TTL_MS - 1);
		store.sweep(DOMAIN, now());
		expect(store.has(DOMAIN, blob.blobId)).toBe(true);
		setNow(now() + 2);
		store.sweep(DOMAIN, now());
		expect(store.has(DOMAIN, blob.blobId)).toBe(false);
		expect(store.status(DOMAIN, blob.blobId)).toEqual({ outcome: "absent" });
	});

	it("a staged blob's hour is kept on disk, so the next process sweeps it on time", () => {
		const first = make();
		const blob = sealed(Buffer.from("restart"));
		stage(first.store, blob);
		first.setNow(first.now() + STAGED_BLOB_TTL_MS + 1);
		first.registry.close();
		const next = make({ from: first });
		next.store.reconcile(DOMAIN);
		expect(next.store.has(DOMAIN, blob.blobId)).toBe(true);
		next.store.sweep(DOMAIN, next.now());
		expect(next.store.has(DOMAIN, blob.blobId)).toBe(false);
		expect(next.store.status(DOMAIN, blob.blobId)).toEqual({ outcome: "absent" });
	});

	it("a slow upload is not swept while chunks keep landing", () => {
		const { store, setNow, now } = make();
		const plain = Buffer.alloc(1_048_576 + 3, 65);
		const blobId = blobIdFor(plain);
		const context = { domainId: DOMAIN, ownerSignPub: "owner", epoch: 1, blobId };
		const first = sealBlobChunk(plain.subarray(0, 1_048_576), Buffer.alloc(32, 4), context, 0, false);
		const second = sealBlobChunk(plain.subarray(1_048_576), Buffer.alloc(32, 4), context, 1, true);
		const digest = `sha256-${crypto
			.createHash("sha256")
			.update(Buffer.concat([first, second]))
			.digest("hex")}`;
		const begun = store.begin(DOMAIN, {
			blobId,
			size: plain.length,
			ciphertextSize: first.length + second.length,
			ciphertextDigest: digest,
			epoch: 1,
		});
		if (begun.outcome !== "lease") throw new Error("expected lease");
		setNow(now() + STAGED_BLOB_TTL_MS - 60_000);
		expect(store.chunk(DOMAIN, blobId, begun.lease, 0, first, false)).toMatchObject({ outcome: "accepted" });
		setNow(now() + 120_000);
		store.sweep(DOMAIN, now());
		expect(store.status(DOMAIN, blobId)).toMatchObject({
			outcome: "staged",
			have: first.length,
			lease: begun.lease,
		});
		expect(store.chunk(DOMAIN, blobId, begun.lease, first.length, second, true)).toEqual({
			outcome: "accepted",
			have: first.length + second.length,
			complete: true,
		});
	});

	it("a row reference outlives its row until the expiry it was bound with", () => {
		const { store, setNow, now } = make();
		const blob = sealed(Buffer.from("row bytes"));
		stage(store, blob);
		store.publish(DOMAIN, [{ ref: row, blobIds: [blob.blobId], expiresAt: now() + 10_000 }], () => {});
		setNow(now() + 5_000);
		store.sweep(DOMAIN, now());
		expect(store.has(DOMAIN, blob.blobId)).toBe(true);
		setNow(now() + 6_000);
		store.sweep(DOMAIN, now());
		expect(store.has(DOMAIN, blob.blobId)).toBe(false);
	});

	it("a hold is released only by its expiry, and a live record keeps its reference past one", () => {
		const { store, registry, setNow, now } = make();
		const blob = sealed(Buffer.from("held"));
		stage(store, blob);
		const hold: BlobReference = { kind: "hold", gatewayId: "gateway", holdId: "relay-1" };
		store.publish(
			DOMAIN,
			[
				{ ref: hold, blobIds: [blob.blobId], expiresAt: now() + 1_000 },
				{ ref: entry, blobIds: [blob.blobId] },
			],
			(tx) => tx.put("board.entry", "entry-1", null, { clear: { id: "entry-1" } }),
		);
		setNow(now() + 2_000);
		store.sweep(DOMAIN, now());
		expect(store.refs(DOMAIN, blob.blobId)).toEqual([entry]);
		const record = registry.for(DOMAIN).get("board.entry", "entry-1");
		registry.for(DOMAIN).del("board.entry", "entry-1", record?.version ?? 0);
		store.sweep(DOMAIN, now());
		expect(store.has(DOMAIN, blob.blobId)).toBe(false);
	});

	it("moves one blob between references in one line without losing the bytes", () => {
		const { store } = make();
		const blob = sealed(Buffer.from("move"));
		stage(store, blob);
		const to: BlobReference = { kind: "entry", entryId: "to" };
		store.publish(DOMAIN, [{ ref: entry, blobIds: [blob.blobId] }], () => {});
		store.publish(
			DOMAIN,
			[
				{ ref: entry, blobIds: [] },
				{ ref: to, blobIds: [blob.blobId] },
			],
			() => {},
		);
		expect(store.has(DOMAIN, blob.blobId)).toBe(true);
		expect(store.refs(DOMAIN, blob.blobId)).toEqual([to]);
	});

	it("referenced bytes are never replaced by a begin, while a staged blob restarts under a new digest", () => {
		const { store } = make();
		const blob = sealed(Buffer.from("same plaintext"));
		const other = sealed(Buffer.from("same plaintext"), 2);
		stage(store, blob);
		expect(store.begin(DOMAIN, other.declared)).toMatchObject({ outcome: "lease", have: 0 });
		expect(store.has(DOMAIN, blob.blobId)).toBe(false);
		stage(store, other);
		store.publish(DOMAIN, [{ ref: entry, blobIds: [other.blobId] }], () => {});
		expect(store.begin(DOMAIN, blob.declared)).toEqual({ outcome: "complete" });
		expect(store.read(DOMAIN, other.blobId, 0, 100)).toMatchObject({ outcome: "fetched", epoch: 2 });
	});

	it("refuses a stale lease, a gap, and a body that does not match the declared digest", () => {
		const { store } = make();
		const blob = sealed(Buffer.from("guarded"));
		const stale = store.begin(DOMAIN, blob.declared);
		const fresh = store.begin(DOMAIN, blob.declared);
		if (stale.outcome !== "lease" || fresh.outcome !== "lease") throw new Error("expected leases");
		expect(store.chunk(DOMAIN, blob.blobId, stale.lease, 0, blob.bytes, true)).toEqual({
			outcome: "refused",
			reason: "lease",
		});
		expect(store.chunk(DOMAIN, blob.blobId, fresh.lease, 4, blob.bytes.subarray(4), true)).toEqual({
			outcome: "refused",
			reason: "gap",
		});
		const forged = Buffer.from(blob.bytes);
		forged[forged.length - 1] ^= 1;
		expect(store.chunk(DOMAIN, blob.blobId, fresh.lease, 0, forged, true)).toEqual({
			outcome: "refused",
			reason: "digest",
		});
		expect(store.status(DOMAIN, blob.blobId)).toEqual({ outcome: "absent" });
		expect(store.read(DOMAIN, blob.blobId, 0, 10)).toEqual({ outcome: "absent" });
	});

	it("resumes from the bytes the Router already holds", () => {
		const { store } = make();
		const plain = Buffer.alloc(1_048_576 + 3, 66);
		const blobId = blobIdFor(plain);
		const context = { domainId: DOMAIN, ownerSignPub: "owner", epoch: 1, blobId };
		const first = sealBlobChunk(plain.subarray(0, 1_048_576), Buffer.alloc(32, 4), context, 0, false);
		const second = sealBlobChunk(plain.subarray(1_048_576), Buffer.alloc(32, 4), context, 1, true);
		const declared = {
			blobId,
			size: plain.length,
			ciphertextSize: first.length + second.length,
			ciphertextDigest: `sha256-${crypto
				.createHash("sha256")
				.update(Buffer.concat([first, second]))
				.digest("hex")}`,
			epoch: 1,
		};
		const begun = store.begin(DOMAIN, declared);
		if (begun.outcome !== "lease") throw new Error("expected lease");
		store.chunk(DOMAIN, blobId, begun.lease, 0, first, false);
		const resumed = store.begin(DOMAIN, declared);
		expect(resumed).toMatchObject({ outcome: "lease", have: first.length });
		if (resumed.outcome !== "lease") throw new Error("expected lease");
		expect(store.chunk(DOMAIN, blobId, resumed.lease, first.length, second, true)).toMatchObject({
			complete: true,
		});
	});

	it("a begin the quota refuses leaves the staged bytes it would have replaced", () => {
		const { store } = make({ quota: 200 });
		const blob = sealed(Buffer.from("kept"));
		stage(store, blob);
		const replaced = store.begin(DOMAIN, {
			...blob.declared,
			ciphertextDigest: sealed(Buffer.from("other"), 2).declared.ciphertextDigest,
			ciphertextSize: sealedBlobSize(10_000),
			size: 10_000,
			epoch: 2,
		});
		expect(replaced).toEqual({ outcome: "refused", reason: "quota" });
		expect(store.has(DOMAIN, blob.blobId)).toBe(true);
		expect(store.status(DOMAIN, blob.blobId)).toMatchObject({ outcome: "complete", epoch: 1 });
	});

	it("refuses a begin the Domain quota cannot hold", () => {
		const { store } = make({ quota: 40 });
		const small = sealed(Buffer.from("ok"));
		const large = sealed(Buffer.from("this one is over the quota"));
		stage(store, small);
		expect(store.begin(DOMAIN, large.declared)).toEqual({ outcome: "refused", reason: "quota" });
	});

	it("reconcile drops bytes no record names, records with nothing behind them, and the old index", () => {
		const { store, root, registry } = make();
		const blob = sealed(Buffer.from("orphan"));
		stage(store, blob);
		const held = path.join(root, "blobs", DOMAIN, "held");
		fs.writeFileSync(path.join(held, "index.json"), "{}");
		const stray = blobIdFor(Buffer.from("stray")).slice("sha256-".length);
		fs.mkdirSync(path.join(held, stray.slice(0, 2)), { recursive: true });
		fs.writeFileSync(path.join(held, stray.slice(0, 2), stray), "stray");
		registry.for(DOMAIN).put("blob", `sha256-${"c".repeat(64)}`, null, {
			clear: {
				size: 1,
				ciphertextSize: 29,
				ciphertextDigest: "x",
				epoch: 1,
				refs: [],
				expiry: {},
				generation: 1,
				stagedAt: 0,
			},
		});
		store.reconcile(DOMAIN);
		expect(fs.existsSync(path.join(held, "index.json"))).toBe(false);
		expect(fs.existsSync(path.join(held, stray.slice(0, 2), stray))).toBe(false);
		expect(registry.for(DOMAIN).get("blob", `sha256-${"c".repeat(64)}`)).toBeNull();
		expect(store.has(DOMAIN, blob.blobId)).toBe(true);
	});

	it("lists every reference the Domain's records name", () => {
		const { store, registry } = make();
		const owner = registry.ownerKey(DOMAIN).ownerSignPub;
		const s = registry.for(DOMAIN);
		s.put("board.entry", "e1", null, { clear: { id: "e1", attachments: [{ blobId: "sha256-a" }] } });
		s.put("scheduled", "d/g/s", null, {
			clear: { target: { domainId: "d", gatewayId: "g", sessionId: "s" }, files: ["sha256-b"] },
		});
		s.append(`owner:${DOMAIN}/${owner}`, { envelope: { contentRefs: ["sha256-c"] }, acceptedAt: 10, seq: 1 });
		expect(store.inventory(DOMAIN, 100)).toEqual([
			{ ref: "entry:e1", blobIds: ["sha256-a"] },
			{ ref: "scheduled:d/g/s", blobIds: ["sha256-b"] },
			{ ref: `row:owner:${DOMAIN}/${owner}:1`, blobIds: ["sha256-c"], expiresAt: 110 },
		]);
	});
});
