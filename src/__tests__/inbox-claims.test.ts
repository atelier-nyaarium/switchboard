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

	it("clears claims when the address epoch changes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-claims-"));
		roots.push(root);
		const claims = createInboxClaims(root, processAmbient());
		expect(claims.claim(address, 4, 1)).toBeNull();
		expect(claims.claim(address, 4, 2)).toBeNull();
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
