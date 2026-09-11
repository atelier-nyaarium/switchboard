import fs from "node:fs";
import path from "node:path";
import type { Ambient } from "../../shared/ambient.js";
import { type BlobReference, formatBlobReference, parseBlobReference } from "../../shared/blob-reference.js";
import { BlobStore } from "../../shared/blob-store.js";
import { MAX_BLOB_BYTES } from "../../shared/router-protocol.js";
import type { BlobLease } from "../../shared/schemasBlob.js";
import { formatInboxAddress, parseInboxAddress } from "../../shared/schemasInbox.js";
import { ciphertextRangeForPlaintext, sealedBlobSize } from "../../shared/sealed-blob.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import type { OwnerStateStore, StateRecord, WriteResult } from "../owner/ownerStateStore.js";

export const STAGED_BLOB_TTL_MS = 60 * 60 * 1000;

/** One blob journal record. */
interface BlobRecord {
	size: number;
	ciphertextSize: number;
	ciphertextDigest: string;
	epoch: number;
	refs: string[];
	/** Reference retention period. */
	expiry: Record<string, number>;
	lease?: BlobLease;
	generation: number;
	stagedAt: number;
}

export type BlobRefSet = { ref: BlobReference; blobIds: readonly string[]; expiresAt?: number };

export type HeldBegin =
	| { outcome: "lease"; lease: BlobLease; have: number }
	| { outcome: "complete" }
	| { outcome: "refused"; reason: string };
export type HeldChunk =
	| { outcome: "accepted"; have: number; complete: boolean }
	| { outcome: "refused"; reason: string };
export type HeldStatus =
	| { outcome: "absent" }
	| {
			outcome: "staged" | "complete";
			have: number;
			lease?: BlobLease;
			size: number;
			ciphertextSize: number;
			ciphertextDigest: string;
			epoch: number;
	  };
export type HeldRead =
	| { outcome: "fetched"; bytes: Buffer; eof: boolean; epoch: number; offset: number; size: number }
	| { outcome: "absent" };
export type PublishResult = WriteResult | { kind: "blob_missing"; blobId: string };

type Tx = Parameters<Parameters<OwnerStateStore["batch"]>[0]>[0];

/**
 * Router-held bytes and journal.
 */
export class ReferenceHeldStore {
	private readonly stores = new Map<string, BlobStore>();

	constructor(
		private readonly options: {
			dataDir: string;
			registry: OwnerStoreRegistry;
			quotaBytesPerDomain?: number;
			ambient: Pick<Ambient, "now" | "newId">;
		},
	) {}

	/** Complete bytes with record. */
	has(domainId: string, blobId: string): boolean {
		const store = this.options.registry.for(domainId);
		return store.get("blob", blobId) !== null && this.blobs(domainId).stat(blobId).complete;
	}

	refs(domainId: string, blobId: string): BlobReference[] {
		const record = this.options.registry.for(domainId).get("blob", blobId);
		return ((record ? asRecord(record) : undefined)?.refs ?? [])
			.map((id) => parseBlobReference(id))
			.filter((ref): ref is BlobReference => ref !== null);
	}

	begin(
		domainId: string,
		declared: { blobId: string; size: number; ciphertextSize: number; ciphertextDigest: string; epoch: number },
	): HeldBegin {
		const { blobId } = declared;
		if (
			declared.size < 0 ||
			declared.size > MAX_BLOB_BYTES ||
			declared.ciphertextSize !== sealedBlobSize(declared.size)
		)
			return { outcome: "refused", reason: "size" };
		const store = this.options.registry.for(domainId);
		const blobs = this.blobs(domainId);
		const existing = store.get("blob", blobId);
		const current = existing ? asRecord(existing) : undefined;
		const complete = blobs.stat(blobId).complete;
		// Referenced bytes are immutable.
		if (current && complete && (current.refs.length > 0 || current.ciphertextDigest === declared.ciphertextDigest))
			return { outcome: "complete" };
		const quota = this.options.quotaBytesPerDomain ?? Number.MAX_SAFE_INTEGER;
		const reserved = store.list("blob").reduce((sum, record) => {
			if (record.id === blobId) return sum;
			const other = asRecord(record);
			return sum + Math.max(blobs.stat(record.id).have, other.lease ? other.ciphertextSize : 0);
		}, 0);
		if (reserved + declared.ciphertextSize > quota) return { outcome: "refused", reason: "quota" };
		// Only after every refusal.
		if (!current || current.ciphertextDigest !== declared.ciphertextDigest) blobs.remove(blobId);
		const generation = (current?.generation ?? 0) + 1;
		const lease = { id: this.options.ambient.newId(), generation };
		const next: BlobRecord = {
			size: declared.size,
			ciphertextSize: declared.ciphertextSize,
			ciphertextDigest: declared.ciphertextDigest,
			epoch: declared.epoch,
			refs: current?.refs ?? [],
			expiry: current?.expiry ?? {},
			lease,
			generation,
			stagedAt: this.options.ambient.now(),
		};
		const write = store.put("blob", blobId, existing?.version ?? null, { clear: { ...next } });
		if (write.kind !== "ok" && write.kind !== "durability_uncertain")
			return { outcome: "refused", reason: write.kind };
		return { outcome: "lease", lease, have: blobs.stat(blobId).have };
	}

	/** References named by records. */
	inventory(domainId: string, rowTtlMs: number): Array<{ ref: string; blobIds: string[]; expiresAt?: number }> {
		const store = this.options.registry.for(domainId);
		const out: Array<{ ref: string; blobIds: string[]; expiresAt?: number }> = [];
		for (const record of store.list("board.entry")) {
			const attachments = record.clear.attachments as Array<{ blobId: string }> | undefined;
			if (attachments?.length)
				out.push({
					ref: formatBlobReference({ kind: "entry", entryId: record.clear.id as string }),
					blobIds: attachments.map((attachment) => attachment.blobId),
				});
		}
		for (const record of store.list("scheduled")) {
			const files = record.clear.files as string[] | undefined;
			const target = record.clear.target as { domainId: string; gatewayId: string; sessionId: string };
			if (files?.length) out.push({ ref: formatBlobReference({ kind: "scheduled", target }), blobIds: files });
		}
		for (const addressText of store.addresses()) {
			const address = parseInboxAddress(addressText);
			if (!address) continue;
			for (const item of store.rows(addressText, 1, Number.MAX_SAFE_INTEGER)) {
				const row = item.row as { envelope?: { contentRefs?: string[] }; acceptedAt?: number };
				const refs = row.envelope?.contentRefs ?? [];
				if (refs.length)
					out.push({
						ref: formatBlobReference({ kind: "row", address, seq: item.seq }),
						blobIds: refs,
						expiresAt: Number(row.acceptedAt ?? 0) + rowTtlMs,
					});
			}
		}
		return out;
	}

	chunk(
		domainId: string,
		blobId: string,
		lease: BlobLease,
		offset: number,
		bytes: Buffer,
		final: boolean,
	): HeldChunk {
		const store = this.options.registry.for(domainId);
		const blobs = this.blobs(domainId);
		const existing = store.get("blob", blobId);
		const current = existing ? asRecord(existing) : undefined;
		if (
			!existing ||
			!current?.lease ||
			current.lease.id !== lease.id ||
			current.lease.generation !== lease.generation
		)
			return { outcome: "refused", reason: "lease" };
		const have = blobs.stat(blobId).have;
		if (offset > have) return { outcome: "refused", reason: "gap" };
		if (offset + bytes.length > current.ciphertextSize) return { outcome: "refused", reason: "too_large" };
		if (final && current.ciphertextSize !== offset + bytes.length)
			return { outcome: "refused", reason: "size_mismatch" };
		const written = blobs.write(blobId, offset, bytes, final, current.ciphertextDigest);
		if (final && !written.complete) {
			this.put(store, existing, { ...current, lease: undefined, stagedAt: this.options.ambient.now() });
			return { outcome: "refused", reason: "digest" };
		}
		const now = this.options.ambient.now();
		if (written.complete) this.put(store, existing, { ...current, lease: undefined, stagedAt: now });
		else if (now - current.stagedAt > STAGED_BLOB_TTL_MS / 4)
			this.put(store, existing, { ...current, stagedAt: now });
		return { outcome: "accepted", have: written.have, complete: written.complete };
	}

	status(domainId: string, blobId: string): HeldStatus {
		const record = this.options.registry.for(domainId).get("blob", blobId);
		if (!record) return { outcome: "absent" };
		const current = asRecord(record);
		const stat = this.blobs(domainId).stat(blobId);
		if (!stat.complete && stat.have === 0 && !current.lease) return { outcome: "absent" };
		return {
			outcome: stat.complete ? "complete" : "staged",
			have: stat.have,
			...(stat.complete || !current.lease ? {} : { lease: current.lease }),
			size: current.size,
			ciphertextSize: current.ciphertextSize,
			ciphertextDigest: current.ciphertextDigest,
			epoch: current.epoch,
		};
	}

	/** Sealed chunks covering a plaintext range. */
	read(domainId: string, blobId: string, offset: number, length: number): HeldRead {
		const record = this.options.registry.for(domainId).get("blob", blobId);
		const blobs = this.blobs(domainId);
		if (!record || !blobs.stat(blobId).complete) return { outcome: "absent" };
		const current = asRecord(record);
		const covering = ciphertextRangeForPlaintext(offset, length, current.size);
		return {
			outcome: "fetched",
			bytes: blobs.read(blobId, covering.ciphertextOffset, covering.ciphertextLength).bytes,
			eof: offset + length >= current.size,
			epoch: current.epoch,
			offset: covering.plaintextOffset,
			size: current.size,
		};
	}

	/**
	 * Journal mutation and references.
	 */
	publish(domainId: string, sets: readonly BlobRefSet[], mutate: (tx: Tx) => void): PublishResult {
		const store = this.options.registry.for(domainId);
		const blobs = this.blobs(domainId);
		const desired = new Map<string, { blobIds: Set<string>; expiresAt?: number }>();
		for (const set of sets) {
			const refId = formatBlobReference(set.ref);
			const entry = desired.get(refId) ?? { blobIds: new Set<string>() };
			for (const blobId of set.blobIds) entry.blobIds.add(blobId);
			if (set.expiresAt !== undefined) entry.expiresAt = set.expiresAt;
			desired.set(refId, entry);
		}
		const affected = new Map<string, StateRecord>();
		for (const entry of desired.values())
			for (const blobId of entry.blobIds) {
				const record = affected.get(blobId) ?? store.get("blob", blobId);
				if (!record || !blobs.stat(blobId).complete) return { kind: "blob_missing", blobId };
				affected.set(blobId, record);
			}
		if (desired.size > 0)
			for (const record of store.list("blob"))
				if (asRecord(record).refs.some((id) => desired.has(id))) affected.set(record.id, record);
		const emptied: string[] = [];
		const updates: Array<{ record: StateRecord; next: BlobRecord | null }> = [];
		for (const [blobId, record] of affected) {
			const current = asRecord(record);
			const refs = current.refs.filter((id) => !desired.has(id));
			const expiry = Object.fromEntries(Object.entries(current.expiry).filter(([id]) => !desired.has(id)));
			for (const [refId, entry] of desired) {
				if (!entry.blobIds.has(blobId)) continue;
				refs.push(refId);
				if (entry.expiresAt !== undefined) expiry[refId] = entry.expiresAt;
			}
			if (refs.length === 0) {
				emptied.push(blobId);
				updates.push({ record, next: null });
			} else updates.push({ record, next: { ...current, refs: [...new Set(refs)], expiry } });
		}
		const write = store.batch((tx) => {
			for (const { record, next } of updates) {
				if (next) tx.put("blob", record.id, record.version, { clear: { ...next } });
				else tx.del("blob", record.id, record.version);
			}
			mutate(tx);
		});
		if (write.kind === "ok") for (const blobId of emptied) blobs.remove(blobId);
		return write;
	}

	/** Releases unreferenced staged bytes. */
	sweep(domainId: string, now: number): void {
		const store = this.options.registry.for(domainId);
		const blobs = this.blobs(domainId);
		for (const record of store.list("blob")) {
			const current = asRecord(record);
			const refs = current.refs.filter((id) => {
				const ref = parseBlobReference(id);
				if (ref && this.alive(store, ref)) return true;
				const until = current.expiry[id];
				return until !== undefined && until > now;
			});
			const expiredStage = refs.length === 0 && now - current.stagedAt > STAGED_BLOB_TTL_MS;
			const released = refs.length === 0 && current.refs.length > 0;
			if (expiredStage || released) {
				const write = store.del("blob", record.id, record.version);
				if (write.kind === "ok") blobs.remove(record.id);
				continue;
			}
			if (refs.length !== current.refs.length) {
				const expiry = Object.fromEntries(Object.entries(current.expiry).filter(([id]) => refs.includes(id)));
				this.put(store, record, { ...current, refs, expiry });
			}
		}
	}

	/** Removes unreferenced boot data. */
	reconcile(domainId: string): void {
		const store = this.options.registry.for(domainId);
		const blobs = this.blobs(domainId);
		const root = this.root(domainId);
		fs.rmSync(path.join(root, "index.json"), { force: true });
		fs.rmSync(path.join(this.options.dataDir, "blobs", domainId, "cache"), { recursive: true, force: true });
		fs.rmSync(path.join(this.options.dataDir, "blob-cache-metadata", domainId), { recursive: true, force: true });
		const known = new Set(store.list("blob").map((record) => record.id));
		for (const fanout of readDirectories(root))
			for (const name of readFiles(path.join(root, fanout))) {
				const blobId = `sha256-${name.endsWith(".part") ? name.slice(0, -".part".length) : name}`;
				if (!known.has(blobId)) fs.rmSync(path.join(root, fanout, name), { force: true });
			}
		for (const record of store.list("blob")) {
			const current = asRecord(record);
			const stat = blobs.stat(record.id);
			if (stat.complete || stat.have > 0 || current.lease) continue;
			if (current.refs.length > 0)
				console.warn(`[router] blob ${record.id} in ${domainId} is referenced but holds no bytes`);
			else store.del("blob", record.id, record.version);
		}
	}

	private alive(store: OwnerStateStore, ref: BlobReference): boolean {
		if (ref.kind === "entry") return store.get("board.entry", ref.entryId) !== null;
		if (ref.kind === "scheduled")
			return (
				store.get("scheduled", `${ref.target.domainId}/${ref.target.gatewayId}/${ref.target.sessionId}`) !==
				null
			);
		if (ref.kind === "row")
			return store.rows(formatInboxAddress(ref.address), ref.seq, 1).some((row) => row.seq === ref.seq);
		return false;
	}

	private put(store: OwnerStateStore, existing: StateRecord, next: BlobRecord): void {
		const clear = { ...next };
		if (clear.lease === undefined) delete clear.lease;
		store.put("blob", existing.id, existing.version, { clear });
	}

	private blobs(domainId: string): BlobStore {
		const existing = this.stores.get(domainId);
		if (existing) return existing;
		const root = this.root(domainId);
		fs.mkdirSync(root, { recursive: true });
		const store = new BlobStore(root, this.options.ambient);
		this.stores.set(domainId, store);
		return store;
	}

	private root(domainId: string): string {
		return path.join(this.options.dataDir, "blobs", domainId, "held");
	}
}

const asRecord = (record: StateRecord): BlobRecord => record.clear as unknown as BlobRecord;

function readDirectories(root: string): string[] {
	try {
		return fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory());
	} catch {
		return [];
	}
}

function readFiles(directory: string): string[] {
	try {
		return fs.readdirSync(directory).filter((name) => fs.statSync(path.join(directory, name)).isFile());
	} catch {
		return [];
	}
}
