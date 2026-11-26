import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInboxClaims } from "../gateway/router/inboxClaims.js";
import { processAmbient } from "../shared/ambient.js";

const roots: string[] = [];
const address = "session:domain/gateway/session";

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("InboxClaims", () => {
	it("survives reopen and re-acks a claimed delivery with its outcome", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const first = createInboxClaims(root, { now: () => 10 });
		expect(first.claim(address, 4, 1)).toBeNull();
		first.setOutcome(address, 4, 1, "failed");

		const reopened = createInboxClaims(root, { now: () => 20 });
		const claim = reopened.claim(address, 4, 1);
		expect(claim).toMatchObject({ deliveryId: `${address}:4:1`, outcome: "failed" });
	});

	it("deletes a forgotten address's file and its claims, and no other's", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const other = "session:domain/gateway/other";
		const claims = createInboxClaims(root, { now: () => 10 });
		claims.claim(address, 4, 1);
		claims.claim(other, 4, 1);

		expect(claims.forget(address)).toBe(true);

		expect(fs.readdirSync(path.join(root, "inbox-claims"))).toHaveLength(1);
		const reopened = createInboxClaims(root, { now: () => 20 });
		expect(reopened.get(address, 4, 1)).toBeNull();
		expect(reopened.get(other, 4, 1)).toMatchObject({ seq: 4 });
	});

	it("keeps no file for an address with no claims, and drops a claim its row has outlived", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const other = "session:domain/gateway/other";
		let now = 10;
		const claims = createInboxClaims(root, { now: () => now });
		claims.claim(address, 4, 1);
		claims.ack(address, 4, 1);
		expect(claims.addresses()).toEqual([]);

		claims.claim(address, 5, 1);
		now = 20;
		claims.claim(other, 6, 1);

		expect(claims.sweep(15)).toBe(1);
		expect(claims.addresses()).toEqual([other]);
		expect(createInboxClaims(root, { now: () => now }).get(other, 6, 1)).toMatchObject({ seq: 6 });
	});

	it("clears claims when the address epoch changes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const claims = createInboxClaims(root, processAmbient());
		claims.claim(address, 4, 1);
		claims.setOutcome(address, 4, 1, "delivered");
		claims.claim(address, 5, 2);
		expect(claims.at(address)).toEqual([
			{
				deliveryId: `${address}:5:2`,
				seq: 5,
				deliveryEpoch: 2,
				offeredAt: expect.any(Number),
				outcome: "waking",
			},
		]);
	});

	it("lists an address's claims and returns none without a file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const claims = createInboxClaims(root, processAmbient());
		const other = "session:domain/gateway/other";
		claims.claim(address, 2, 1);
		expect(claims.at(address)).toMatchObject([{ deliveryId: `${address}:2:1`, outcome: "waking" }]);
		expect(claims.at(other)).toEqual([]);
		expect(claims.addresses()).toEqual([address]);
	});

	it("holds no claim a failed write did not land, so a retry claims again", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const claims = createInboxClaims(root, processAmbient());
		expect(claims.claim(address, 3, 1)).toBeNull();
		const blocked = path.join(root, "inbox-claims");
		fs.rmSync(blocked, { recursive: true });
		fs.writeFileSync(blocked, "not a directory");

		expect(() => claims.claim(address, 4, 1)).toThrow();
		fs.rmSync(blocked);
		expect(claims.claim(address, 4, 1)).toBeNull();
		expect(claims.get(address, 4, 1)).toMatchObject({ outcome: "waking" });
	});

	it("returns a claim only for its matching epoch", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const claims = createInboxClaims(root, processAmbient());
		claims.claim(address, 4, 1);

		expect(claims.get(address, 4, 1)).toMatchObject({ deliveryEpoch: 1 });
		expect(claims.get(address, 4, 2)).toBeNull();
	});
});
