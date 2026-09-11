import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createBlobUploader } from "../gateway/router/blobUploader.js";
import { blobIdFor } from "../shared/blob-store.js";
import { BLOB_CHUNK_BYTES, BLOB_CIPHERTEXT_CHUNK_BYTES } from "../shared/router-protocol.js";
import { openSealedBlobRange, sealedBlobSize } from "../shared/sealed-blob.js";

const key = Buffer.alloc(32, 7);
const ownerSignPub = "owner";
const domainId = "domain";
const lease = { id: "lease-1", generation: 1 };

function blobStub(bytes: Buffer, complete = true) {
	return {
		stat: vi.fn(() =>
			complete
				? { have: bytes.length, size: bytes.length, complete: true }
				: { have: bytes.length, complete: false },
		),
		read: vi.fn((_blobId: string, offset: number, length: number) => ({
			bytes: bytes.subarray(offset, offset + length),
			eof: offset + length >= bytes.length,
		})),
	};
}

function uploader(
	bytes: Buffer,
	call: (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>,
	complete = true,
) {
	return createBlobUploader({
		call,
		blobs: blobStub(bytes, complete),
		incarnation: () => 1,
		domainId,
		ownerSignPub: () => ownerSignPub,
		keys: { epochs: () => [3], keyFor: () => key },
	});
}

const leased = (have = 0) => ({ result: { outcome: "lease", lease, have } });
const accepted = (complete: boolean) => ({ result: { outcome: "accepted", have: 1, complete } });

describe("blob uploader", () => {
	it("declares and stages the exact sealed bytes", async () => {
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES + 7, 65);
		const blobId = blobIdFor(bytes);
		const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
		const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
			calls.push({ action, params });
			return action === "blob_begin" ? leased() : accepted(true);
		});

		expect(await uploader(bytes, call).stage(blobId)).toEqual({ kind: "staged" });
		const begin = calls[0].params;
		const frames = calls.slice(1).map((entry) => Buffer.from(entry.params.bytes as string, "base64"));
		const ciphertext = Buffer.concat(frames);
		expect(begin).toEqual({
			blobId,
			size: bytes.length,
			ciphertextSize: sealedBlobSize(bytes.length),
			ciphertextDigest: `sha256-${crypto.createHash("sha256").update(ciphertext).digest("hex")}`,
			epoch: 3,
		});
		expect(calls.slice(1).map((entry) => entry.params.final)).toEqual([false, true]);
		expect(calls.slice(1).map((entry) => entry.params.offset)).toEqual([0, BLOB_CIPHERTEXT_CHUNK_BYTES]);
		expect(frames[0].subarray(0, 12)).not.toEqual(frames[1].subarray(0, 12));
		const opened = openSealedBlobRange(
			{ bytes: ciphertext, offset: 0, size: bytes.length, epoch: 3 },
			0,
			bytes.length,
			key,
			{ domainId, ownerSignPub, blobId },
		);
		expect(opened.bytes).toEqual(bytes);
	});

	it("resumes from the chunk the Router's cursor names", async () => {
		const bytes = Buffer.alloc(BLOB_CHUNK_BYTES * 2 + 1, 66);
		const call = vi.fn(async (action: string, _params: Record<string, unknown>) =>
			action === "blob_begin" ? leased(BLOB_CIPHERTEXT_CHUNK_BYTES) : accepted(true),
		);
		expect(await uploader(bytes, call).stage(blobIdFor(bytes))).toEqual({ kind: "staged" });
		expect(call.mock.calls.slice(1).map((entry) => entry[1].offset)).toEqual([
			BLOB_CIPHERTEXT_CHUNK_BYTES,
			BLOB_CIPHERTEXT_CHUNK_BYTES * 2,
		]);
	});

	it("seals an empty blob as one authenticated final frame", async () => {
		const bytes = Buffer.alloc(0);
		const call = vi.fn().mockResolvedValueOnce(leased()).mockResolvedValueOnce(accepted(true));
		expect(await uploader(bytes, call).stage(blobIdFor(bytes))).toEqual({ kind: "staged" });
		expect(Buffer.from(call.mock.calls[1][1].bytes, "base64")).toHaveLength(28);
		expect(call.mock.calls[1][1].final).toBe(true);
	});

	it("does not stage incomplete or keyless blobs", async () => {
		const bytes = Buffer.from("partial");
		const call = vi.fn();
		expect(await uploader(bytes, call, false).stage(blobIdFor(bytes))).toEqual({ kind: "absent" });
		const keyless = createBlobUploader({
			call,
			blobs: blobStub(bytes),
			incarnation: () => 1,
			domainId,
			ownerSignPub: () => ownerSignPub,
			keys: { epochs: () => [], keyFor: () => null },
		});
		expect(await keyless.stage(blobIdFor(bytes))).toMatchObject({ kind: "failed" });
		expect(call).not.toHaveBeenCalled();
	});

	it("stops after a Router chunk refusal", async () => {
		const bytes = Buffer.from("refused");
		const call = vi
			.fn()
			.mockResolvedValueOnce(leased())
			.mockResolvedValueOnce({ result: { outcome: "refused", reason: "gap" } });
		expect(await uploader(bytes, call).stage(blobIdFor(bytes))).toEqual({ kind: "failed", error: "gap" });
		expect(call).toHaveBeenCalledTimes(2);
	});

	it("does not send chunks when the Router already holds the blob", async () => {
		const bytes = Buffer.from("held");
		const call = vi.fn().mockResolvedValue({ result: { outcome: "complete" } });
		expect(await uploader(bytes, call).stage(blobIdFor(bytes))).toEqual({ kind: "already_held" });
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("answers failed when begin is refused, without sending a chunk", async () => {
		const bytes = Buffer.from("quota");
		const call = vi.fn().mockResolvedValue({ result: { outcome: "refused", reason: "quota" } });
		expect(await uploader(bytes, call).stage(blobIdFor(bytes))).toEqual({ kind: "failed", error: "quota" });
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("answers failed without calling the Router when the gateway is unregistered", async () => {
		const bytes = Buffer.from("local");
		const blobs = blobStub(bytes);
		const call = vi.fn();
		const value = createBlobUploader({
			call,
			blobs,
			incarnation: () => null,
			domainId,
			ownerSignPub: () => ownerSignPub,
			keys: { epochs: () => [3], keyFor: () => key },
		});
		expect(await value.stage(blobIdFor(bytes))).toMatchObject({ kind: "failed" });
		expect(call).not.toHaveBeenCalled();
		expect(blobs.stat).not.toHaveBeenCalled();
	});

	it("holds a staged blob under this Gateway's name for the time asked", async () => {
		const answers: Array<{ result: unknown }> = [
			{ result: { outcome: "accepted" } },
			{ result: { outcome: "refused", reason: "blob_missing" } },
		];
		const call = vi.fn(async () => answers.shift() ?? { result: {} });
		const value = uploader(Buffer.from("x"), call);
		expect(await value.hold("sha256-x", "relay-1", 5_000)).toBe(true);
		expect(call).toHaveBeenCalledWith("blob_hold", { blobId: "sha256-x", holdId: "relay-1", ttlMs: 5_000 });
		expect(await value.hold("sha256-x", "relay-2", 5_000)).toBe(false);
	});
});
