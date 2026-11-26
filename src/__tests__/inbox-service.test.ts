import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceHeldStore } from "../federation-server/blobs/referenceHeldStore.js";
import { INBOX_HOLD_MS } from "../federation-server/inbox/inboxCustody.js";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OP_LEDGER_SWEEP_BATCH, OP_LEDGER_TTL_MS, sweepOpLedger } from "../federation-server/inbox/inboxSweep.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import { processAmbient } from "../shared/ambient.js";
import { blobIdFor } from "../shared/blob-store.js";
import { generateIdentity } from "../shared/crypto.js";
import { INBOX_ROW_TTL_MS, type InboxAddress, type InboxRowInput, signRowEnvelope } from "../shared/schemasInbox.js";
import { sealBlobChunk } from "../shared/sealed-blob.js";

const roots: string[] = [];
const domainId = "domain-a";
const make = (options: { now?: () => number; ownerOf?: (domainId: string) => string | null } = {}) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-service-"));
	roots.push(dataDir);
	let owner = generateIdentity();
	while (owner.sign.pub.includes("/")) owner = generateIdentity();
	const producer = generateIdentity();
	const producer2 = generateIdentity();
	const router = generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: options.ownerOf ?? (() => owner.sign.pub),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: options.now ?? (() => 100) },
	});
	return {
		service: new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv }),
		registry,
		dataDir,
		owner,
		producer,
		producer2,
		router,
	};
};
const rowFor = (
	producer: ReturnType<typeof generateIdentity>,
	opId = "op-1",
	origin: InboxRowInput["envelope"]["origin"] = { kind: "console", domainId, device: "phone" },
) => {
	const envelope = {
		origin,
		opKey: { conversationId: "conversation", opId },
		epoch: "clear" as const,
		kind: "op_result" as const,
		contentRefs: [],
	};
	return { envelope, producerSig: signRowEnvelope(envelope, producer.sign.priv), body: { outcome: "accepted" } };
};
const ownerAddress = (owner: ReturnType<typeof generateIdentity>): InboxAddress => ({
	kind: "owner",
	domainId,
	ownerSignPub: owner.sign.pub,
});

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("InboxService", () => {
	it("returns the appended row when the journal fsync is uncertain", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		registry.for(domainId);
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("fsync uncertain");
		});
		const result = service.appendRow({ address, row: rowFor(producer), producerSignPub: producer.sign.pub });
		expect(result.outcome).toBe("durability_uncertain");
		expect(result.row?.seq).toBe(1);
		fsync.mockRestore();
		registry.close();
	});

	it("deduplicates equal hashes and conflicts different hashes", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		const row = rowFor(producer);
		const differentBody = { ...row, body: { outcome: "failed" } };
		const accepted = service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		expect(accepted.outcome).toBe("accepted");
		expect(service.appendRow({ address, row, producerSignPub: producer.sign.pub })).toMatchObject({
			outcome: "accepted",
			seq: 1,
		});
		expect(
			service.appendRow({
				address,
				row: differentBody,
				producerSignPub: producer.sign.pub,
			}),
		).toMatchObject({ outcome: "conflict" });
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		registry.close();
	});

	it("conflicts when an op key is reused at another address", () => {
		const { service, registry, owner, producer } = make();
		const firstAddress = ownerAddress(owner);
		const secondAddress: InboxAddress = { kind: "gateway", domainId, gatewayId: "gateway" };
		const row = rowFor(producer, "same-address");
		expect(service.appendRow({ address: firstAddress, row, producerSignPub: producer.sign.pub }).outcome).toBe(
			"accepted",
		);
		expect(service.appendRow({ address: secondAddress, row, producerSignPub: producer.sign.pub }).outcome).toBe(
			"conflict",
		);
		expect(service.rows(firstAddress, 1, 10)).toHaveLength(1);
		expect(service.rows(secondAddress, 1, 10)).toHaveLength(0);
		registry.close();
	});

	it("deduplicates one op through two producers", () => {
		const { service, registry, owner, producer, producer2 } = make();
		const address = ownerAddress(owner);
		const first = rowFor(producer, "two-connections");
		const second = rowFor(producer2, "two-connections");
		const accepted = service.appendRow({ address, row: first, producerSignPub: producer.sign.pub });
		const replay = service.appendRow({ address, row: second, producerSignPub: producer2.sign.pub });
		expect(replay).toMatchObject({ opKey: accepted.opKey, outcome: accepted.outcome, seq: accepted.seq });
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		registry.close();
	});

	// Producer hash survives resealing.
	it("replays the recorded result for a retry whose bytes changed but whose producer hash did not", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		const row = rowFor(producer);
		const resealed = { ...row, body: { outcome: "resealed" } };
		const opKey = { ...row.envelope.opKey, hash: "a".repeat(64) };

		const first = service.appendRow({ address, row, producerSignPub: producer.sign.pub, opKey });
		const retry = service.appendRow({ address, row: resealed, producerSignPub: producer.sign.pub, opKey });

		expect(first.outcome).toBe("accepted");
		expect(retry).toMatchObject({ outcome: "accepted", seq: 1 });
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		registry.close();
	});

	it("refuses a bad signature and enforces the session cap", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		service.upsertSession(domainId, "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		service.recreateAddress(address);
		const bad = rowFor(producer);
		bad.producerSig = producer.sign.pub;
		expect(service.appendRow({ address, row: bad, producerSignPub: producer.sign.pub })).toMatchObject({
			outcome: "refused",
		});
		for (let i = 0; i < 200; i++) {
			const row = rowFor(producer, `op-${i}`);
			service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		}
		const before = service.rows(address, 1, 10);
		const refused = service.appendRow({
			address,
			row: rowFor(producer, "op-201"),
			producerSignPub: producer.sign.pub,
		});
		expect(refused.outcome).toBe("refused");
		expect(service.rows(address, 1, 10)).toEqual(before);
		registry.close();
	});

	it("checks gateway ownership and incarnation before delivery ack", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		service.upsertSession(domainId, "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		const incarnation = service.registerGateway(domainId, "gateway") as number;
		service.recreateAddress(address);
		const accepted = service.appendRow({ address, row: rowFor(producer), producerSignPub: producer.sign.pub });
		const oldEpoch = service.deliveryEpoch(address);
		const currentEpoch = service.recreateAddress(address);
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				deliveryEpoch: oldEpoch,
				outcome: "delivered",
				by: { domainId, gatewayId: "gateway", incarnation },
			}).outcome,
		).toBe("refused");
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				deliveryEpoch: currentEpoch,
				outcome: "delivered",
				by: { domainId, gatewayId: "other", incarnation },
			}).outcome,
		).toBe("refused");
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				deliveryEpoch: currentEpoch,
				outcome: "delivered",
				by: { domainId, gatewayId: "gateway", incarnation: incarnation - 1 },
			}).outcome,
		).toBe("refused");
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				deliveryEpoch: currentEpoch,
				outcome: "delivered",
				by: { domainId, gatewayId: "gateway", incarnation },
			}).outcome,
		).toBe("delivered");
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				outcome: "delivered",
				by: { domainId, gatewayId: "gateway", incarnation },
			}).outcome,
		).toBe("gone");
		registry.close();
	});

	it("persists gateway incarnations across reopen", () => {
		const first = make();
		const firstValue = first.service.registerGateway(domainId, "gateway") as number;
		first.registry.close();
		const registry = new OwnerStoreRegistry({
			dataDir: roots.at(-1) as string,
			ownerOf: () => first.owner.sign.pub,
			quotaFor: () =>
				new DomainQuota({
					dir: roots.at(-1) as string,
					limitBytes: 100_000_000,
					statfs: () => ({ available: 100_000_000 }),
				}),
			ambient: processAmbient(),
		});
		const service = new InboxService(registry, {
			signPub: first.router.sign.pub,
			signPriv: first.router.sign.priv,
		});
		expect(service.registerGateway(domainId, "gateway")).toBe(firstValue + 1);
		registry.close();
	});

	it("creates a new consumer epoch after forgetting and keeps sequence numbers after compaction", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		const first = service.registerConsumer(domainId, "phone", 1);
		expect(service.advanceCursor(domainId, "phone", 1, first.cursorEpoch)).toEqual({ outcome: "ok" });
		service.forgetConsumer(domainId, "phone");
		expect(service.advanceCursor(domainId, "phone", 0, first.cursorEpoch)).toMatchObject({
			outcome: "cursor_stale",
		});
		const second = service.registerConsumer(domainId, "phone", 2);
		expect(second.cursorEpoch).not.toBe(first.cursorEpoch);
		const accepted = service.appendRow({
			address,
			row: rowFor(producer, "after"),
			producerSignPub: producer.sign.pub,
		});
		service.advanceCursor(domainId, "phone", accepted.seq as number, second.cursorEpoch);
		service.compactOwnerInbox(domainId);
		const later = service.appendRow({
			address,
			row: rowFor(producer, "later"),
			producerSignPub: producer.sign.pub,
		});
		expect(later.seq).toBeGreaterThan(accepted.seq as number);
		registry.close();
	});

	it("retries retirement after a crash before the compaction floor write", () => {
		const { service, registry, owner, producer } = make();
		const address = ownerAddress(owner);
		const consumer = service.registerConsumer(domainId, "phone", 1);
		const accepted = service.appendRow({
			address,
			row: rowFor(producer, "compact"),
			producerSignPub: producer.sign.pub,
		});
		service.advanceCursor(domainId, "phone", accepted.seq as number, consumer.cursorEpoch);
		const store = registry.for(domainId);
		vi.spyOn(store, "retire").mockImplementationOnce(() => {
			throw new Error("crash");
		});
		expect(() => service.compactOwnerInbox(domainId)).toThrow("crash");
		service.compactOwnerInbox(domainId);
		expect(service.rows(address, 1, 10)).toHaveLength(0);
		registry.close();
	});

	it("does not retire a cross-Domain row when the sender result is refused", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-cross-retire-"));
		roots.push(dataDir);
		const destinationOwner = generateIdentity();
		const senderOwner = generateIdentity();
		const router = generateIdentity();
		const producer = generateIdentity();
		const registry = new OwnerStoreRegistry({
			dataDir,
			ownerOf: (id) =>
				id === "destination" ? destinationOwner.sign.pub : id === "sender" ? senderOwner.sign.pub : null,
			quotaFor: () =>
				new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
			ambient: processAmbient(),
		});
		const service = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		const address: InboxAddress = {
			kind: "session",
			domainId: "destination",
			gatewayId: "gateway",
			sessionId: "session",
		};
		service.upsertSession("destination", "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		const sourceRow = rowFor(producer, "cross", {
			kind: "session",
			domainId: "sender",
			gatewayId: "gateway",
			sessionId: "session",
		});
		const peerEnvelope = { ...sourceRow.envelope, epoch: "peer" as const };
		const peerRow = {
			...sourceRow,
			envelope: peerEnvelope,
			producerSig: signRowEnvelope(peerEnvelope, producer.sign.priv),
		};
		const accepted = service.appendRow({
			address,
			row: peerRow,
			producerSignPub: producer.sign.pub,
		});
		const destinationStore = registry.for("destination");
		const before = destinationStore.get(
			"op",
			`op:destination/${accepted.opKey.conversationId}/${accepted.opKey.opId}`,
		);
		const senderStore = registry.for("sender");
		vi.spyOn(senderStore, "batch").mockReturnValue({ kind: "durability_failure", reason: "refused" });
		service.retireRevokedPeerRows("destination", "destination.gateway.session", "sender");
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		expect(
			destinationStore.get("op", `op:destination/${accepted.opKey.conversationId}/${accepted.opKey.opId}`),
		).toEqual(before);
		registry.close();
	});

	it("retires failed rows and records the failed result for the sender", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		const row = rowFor(producer, "failed", {
			kind: "session",
			domainId,
			gatewayId: "gateway",
			sessionId: "session",
		});
		service.upsertSession(domainId, "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		const accepted = service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		const incarnation = service.registerGateway(domainId, "gateway") as number;
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				outcome: "failed",
				by: { domainId, gatewayId: "gateway", incarnation },
			}),
		).toMatchObject({
			outcome: "failed",
		});
		expect(service.opResult(domainId, row.envelope.opKey)).toMatchObject({ outcome: "failed" });
		expect(service.rows(address, 1, 10).at(0)?.body).toMatchObject({ outcome: "failed" });
		expect(
			service.ack({
				address,
				seq: accepted.seq as number,
				outcome: "failed",
				by: { domainId, gatewayId: "gateway", incarnation },
			}),
		).toMatchObject({ outcome: "gone" });
		registry.close();
	});

	it("tells its listener of every row that lands, a retirement's result included, and never of a replay", () => {
		let now = 100;
		const { service, registry, owner, producer } = make({ now: () => now });
		const landed: Array<{ address: string; opId: string }> = [];
		service.onRowAppended((_domain, address, row) => landed.push({ address, opId: row.envelope.opKey.opId }));
		const session: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "spawn.session" };
		const row = rowFor(producer, "to-session");
		service.appendRow({ address: session, row, producerSignPub: producer.sign.pub });
		service.appendRow({ address: session, row, producerSignPub: producer.sign.pub });
		service.appendRouterRow({
			address: ownerAddress(owner),
			kind: "op_result",
			opKey: { conversationId: "router", opId: "from-router" },
			body: { outcome: "accepted" },
		});
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);

		const ownerText = `owner:${domainId}/${owner.sign.pub}`;
		expect(landed).toEqual([
			{ address: `session:${domainId}/gateway/spawn.session`, opId: "to-session" },
			{ address: ownerText, opId: "from-router" },
			{ address: ownerText, opId: "to-session" },
		]);
		registry.close();
	});

	it("keeps an append, a retirement and the sweep whole when a row listener throws", () => {
		let now = 100;
		const { service, registry, owner, producer } = make({ now: () => now });
		service.onRowAppended(() => {
			throw new Error("listener down");
		});
		const retired: string[] = [];
		service.onRowRetired((_domain, _address, row) => retired.push(row.envelope.opKey.opId));
		const session: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "spawn.session" };
		const first = service.appendRow({
			address: session,
			row: rowFor(producer, "first"),
			producerSignPub: producer.sign.pub,
		});
		service.appendRow({ address: session, row: rowFor(producer, "second"), producerSignPub: producer.sign.pub });
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);

		expect(first.outcome).toBe("accepted");
		expect(retired).toEqual(["first", "second"]);
		expect(service.rows(ownerAddress(owner), 1, 10)).toHaveLength(2);
		registry.close();
	});

	it("expires owner rows and raises the consumer floor", () => {
		let now = 100;
		const { service, registry, owner, producer } = make({ now: () => now });
		const consumer = service.registerConsumer(domainId, "phone", 1);
		const ownerAddr = ownerAddress(owner);
		const expired = service.appendRow({
			address: ownerAddr,
			row: rowFor(producer, "expired"),
			producerSignPub: producer.sign.pub,
		});
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		expect(service.readOwner(domainId, "phone", consumer.cursor, 10, consumer.cursorEpoch)).toMatchObject({
			floor: (expired.seq as number) + 1,
		});
		registry.close();
	});

	it("keeps an op's ledger entry a week past its row's lifetime, then takes that op as new", () => {
		let now = 100;
		const { service, registry, owner, producer } = make({ now: () => now });
		const address = ownerAddress(owner);
		const row = rowFor(producer, "once");
		const append = () => service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		const first = append();

		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		expect(sweepOpLedger(registry, domainId, now)).toBe(0);
		// The entry still answers a late duplicate.
		expect(append()).toMatchObject({ seq: first.seq });

		now += 7 * 24 * 60 * 60_000;
		expect(sweepOpLedger(registry, domainId, now)).toBe(1);
		expect(append().seq).not.toBe(first.seq);
		registry.close();
	});

	it("drops a pass's due ledger entries in one write, at most a batch", () => {
		const now = OP_LEDGER_TTL_MS + 1_000;
		const { registry } = make({ now: () => now });
		const store = registry.for(domainId);
		const seeded = store.batch((tx) => {
			for (let index = 0; index < OP_LEDGER_SWEEP_BATCH + 5; index += 1)
				tx.put("op", `old-${index}`, null, { clear: { at: 0 } });
			tx.put("op", "recent", null, { clear: { at: now } });
		});
		expect(seeded.kind).toBe("ok");
		let marks = 0;
		const seq = () => {
			marks += 1;
			return (store.put("nonce", `mark-${marks}`, null, { clear: { at: now } }) as { seq: number }).seq;
		};

		const before = seq();
		expect(sweepOpLedger(registry, domainId, now)).toBe(OP_LEDGER_SWEEP_BATCH);
		// The sweep's one write, then the mark's.
		expect(seq() - before).toBe(2);
		expect(sweepOpLedger(registry, domainId, now)).toBe(5);
		expect(sweepOpLedger(registry, domainId, now)).toBe(0);
		expect(store.list("op").map((record) => record.id)).toEqual(["recent"]);
		registry.close();
	});

	it("expires router rows without writing a result row", () => {
		let now = 100;
		const { service, registry, owner, producer } = make({ now: () => now });
		const address = ownerAddress(owner);
		const routerRow = rowFor(producer, "router", { kind: "router", domainId });
		service.appendRow({ address, row: routerRow, producerSignPub: producer.sign.pub });
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		expect(service.rows(address, 1, 10)).toEqual([]);
		registry.close();
	});

	it("expires a session row into its origin session", () => {
		let now = 100;
		const { service, registry, producer } = make({ now: () => now });
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		const row = rowFor(producer, "session-expired", {
			kind: "session",
			domainId,
			gatewayId: "gateway",
			sessionId: "session",
		});
		service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		expect(service.rows(address, 1, 10).at(0)?.body).toMatchObject({ outcome: "expired" });
		registry.close();
	});

	it("expires a peer row into its origin Domain gateway inbox", () => {
		let now = 100;
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-service-peer-expiry-"));
		roots.push(dataDir);
		const originOwner = generateIdentity();
		const targetOwner = generateIdentity();
		const producer = generateIdentity();
		const router = generateIdentity();
		const owners = new Map([
			["origin", originOwner.sign.pub],
			["target", targetOwner.sign.pub],
		]);
		const registry = new OwnerStoreRegistry({
			dataDir,
			ownerOf: (id) => owners.get(id) ?? null,
			quotaFor: () =>
				new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
			ambient: { now: () => now },
		});
		const service = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		const address: InboxAddress = { kind: "gateway", domainId: "target", gatewayId: "destination" };
		const row = rowFor(producer, "peer-expired", {
			kind: "gateway",
			domainId: "origin",
			gatewayId: "source",
		});
		service.appendRow({ address, row, producerSignPub: producer.sign.pub });
		now += INBOX_ROW_TTL_MS + 1;
		service.sweep(now);
		const second = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
		expect(
			second.rows({ kind: "gateway", domainId: "origin", gatewayId: "source" }, 1, 10).at(0)?.body,
		).toMatchObject({ outcome: "expired" });
		registry.close();
	});

	it("forgets session rows with failed results and advances its delivery epoch", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
		service.upsertSession(domainId, "gateway", "session", { kind: "shell", label: "x", recordExists: true });
		service.recreateAddress(address);
		service.appendRow({
			address,
			row: rowFor(producer, "forgotten", {
				kind: "session",
				domainId,
				gatewayId: "gateway",
				sessionId: "session",
			}),
			producerSignPub: producer.sign.pub,
		});
		const before = service.deliveryEpoch(address);
		service.forgetSession(domainId, "gateway", "session");
		expect(service.deliveryEpoch(address)).not.toBe(before);
		expect(service.rows(address, 1, 10).at(0)?.body).toMatchObject({ outcome: "failed" });
		expect(service.hasSession(domainId, "gateway", "session")).toBe(false);
		registry.close();
	});

	it("refreshes an old consumer read and forgets idle consumers before compacting", () => {
		let now = 100;
		const { service, registry, owner } = make({ now: () => now });
		const consumer = service.registerConsumer(domainId, "phone", 1);
		now += 60 * 60 * 1000 + 1;
		service.readOwner(domainId, "phone", consumer.cursor, 10, consumer.cursorEpoch);
		now += 30 * 24 * 60 * 60 * 1000 + 1;
		service.sweep(now);
		expect(service.readOwner(domainId, "phone", 0, 10, consumer.cursorEpoch)).toMatchObject({
			outcome: "cursor_stale",
		});
		void owner;
		registry.close();
	});

	it("refuses an owner address for a different owner key", () => {
		const { service, registry, producer } = make();
		const address: InboxAddress = { kind: "owner", domainId, ownerSignPub: generateIdentity().sign.pub };
		expect(service.appendRow({ address, row: rowFor(producer), producerSignPub: producer.sign.pub })).toMatchObject(
			{ outcome: "refused" },
		);
		registry.close();
	});

	it("returns null when gateway registration cannot write a quarantined store", () => {
		const fixture = make();
		vi.spyOn(fixture.registry, "for").mockImplementation(() => {
			throw new OwnerQuarantined({ from: 1, to: 1 });
		});
		expect(fixture.service.registerGateway(domainId, "gateway")).toBeNull();
		fixture.registry.close();
	});
});

describe("InboxService content references", () => {
	const stage = (held: ReferenceHeldStore, plain: Buffer) => {
		const blobId = blobIdFor(plain);
		const frame = sealBlobChunk(
			plain,
			Buffer.alloc(32, 2),
			{ domainId, ownerSignPub: "owner", epoch: 1, blobId },
			0,
			true,
		);
		const begun = held.begin(domainId, {
			blobId,
			size: plain.length,
			ciphertextSize: frame.length,
			ciphertextDigest: `sha256-${crypto.createHash("sha256").update(frame).digest("hex")}`,
			epoch: 1,
		});
		if (begun.outcome !== "lease") throw new Error("expected lease");
		held.chunk(domainId, blobId, begun.lease, 0, frame, true);
		return blobId;
	};
	const naming = (producer: ReturnType<typeof generateIdentity>, opId: string, contentRefs: string[]) => {
		const envelope = {
			origin: { kind: "console" as const, domainId, device: "phone" },
			opKey: { conversationId: "conversation", opId },
			epoch: 1,
			kind: "message" as const,
			contentRefs,
		};
		return {
			envelope,
			producerSig: signRowEnvelope(envelope, producer.sign.priv),
			body: {
				v: 1 as const,
				epoch: 1,
				nonce: Buffer.alloc(12).toString("base64"),
				ciphertext: Buffer.alloc(16).toString("base64"),
			},
		};
	};

	it("a row binds the bytes it names in its own line and is refused while they are not held", () => {
		const now = 5_000;
		const fixture = make({ now: () => now });
		const held = new ReferenceHeldStore({
			dataDir: fixture.dataDir,
			registry: fixture.registry,
			ambient: { now: () => now, newId: () => "lease" },
		});
		const service = new InboxService(
			fixture.registry,
			{ signPub: fixture.router.sign.pub, signPriv: fixture.router.sign.priv },
			held,
		);
		const address = ownerAddress(fixture.owner);
		const blobId = blobIdFor(Buffer.from("named"));
		expect(
			service.appendRow({
				address,
				row: naming(fixture.producer, "op-1", [blobId]),
				producerSignPub: fixture.producer.sign.pub,
			}),
		).toMatchObject({ outcome: "refused", reason: "blob_missing" });
		expect(service.rows(address, 1, 10)).toEqual([]);
		stage(held, Buffer.from("named"));
		const accepted = service.appendRow({
			address,
			row: naming(fixture.producer, "op-1", [blobId]),
			producerSignPub: fixture.producer.sign.pub,
		});
		expect(accepted).toMatchObject({ outcome: "accepted", seq: 1 });
		expect(held.refs(domainId, blobId)).toEqual([{ kind: "row", address, seq: 1 }]);
		fixture.registry.for(domainId).retire(`owner:${domainId}/${fixture.owner.sign.pub}`, 1);
		held.sweep(domainId, now + INBOX_ROW_TTL_MS - 1);
		expect(held.has(domainId, blobId)).toBe(true);
		held.sweep(domainId, now + INBOX_ROW_TTL_MS + 1);
		expect(held.has(domainId, blobId)).toBe(false);
		fixture.registry.close();
	});
});

describe("InboxService: a pushed row is its holder's to settle", () => {
	const address: InboxAddress = { kind: "session", domainId, gatewayId: "gateway", sessionId: "session" };
	const session = { kind: "shell", label: "x", recordExists: true };
	const opKey = (opId: string) => ({ conversationId: "conversation", opId });
	const opRow = (
		producer: ReturnType<typeof generateIdentity>,
		opId: string,
		kind: "console_op" | "op_result",
		origin: InboxRowInput["envelope"]["origin"],
	) => {
		const envelope = { origin, opKey: opKey(opId), epoch: 1, kind, contentRefs: [] };
		const body = { v: 1, epoch: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" };
		return { envelope, producerSig: signRowEnvelope(envelope, producer.sign.priv), body };
	};
	const world = (options: Parameters<typeof make>[0] = {}) => {
		const made = make(options);
		const { service, producer, owner } = made;
		service.upsertSession(domainId, "gateway", "session", session);
		let live: number | null = service.registerGateway(domainId, "gateway") as number;
		service.setHolderGate(() => live);
		const land = (opId: string): number =>
			service.appendRow({
				address,
				row: opRow(producer, opId, "console_op", { kind: "console", domainId, device: "phone" }),
				producerSignPub: producer.sign.pub,
			}).seq as number;
		const hand = (seq: number): number => {
			service.pushed(address, [seq], { gatewayId: "gateway", incarnation: live as number });
			return seq;
		};
		return {
			...made,
			land,
			hand,
			push: (opId: string) => hand(land(opId)),
			answer: (opId: string) =>
				service.appendRow({
					address: ownerAddress(owner),
					row: opRow(producer, opId, "op_result", { kind: "gateway", domainId, gatewayId: "gateway" }),
					producerSignPub: producer.sign.pub,
				}),
			answersTo: (opId: string) =>
				service
					.rows(ownerAddress(owner), 1, 100)
					.filter((row) => row.envelope.opKey.opId === opId)
					.map((row) => row.envelope.origin.kind),
			ack: (seq: number, deliveryEpoch: number, outcome: "delivered" | "waking" | "failed") =>
				service.ack({
					address,
					seq,
					deliveryEpoch,
					outcome,
					by: { domainId, gatewayId: "gateway", incarnation: live as number },
				}),
			drop: () => {
				live = null;
			},
		};
	};

	it("leaves a held row to its holder over a forget: its answer lands and its ack is taken under its own epoch", () => {
		const { service, registry, push, answer, answersTo, ack } = world();
		const seq = push("forget");
		const pushedUnder = service.deliveryEpoch(address);
		expect(service.forgetSession(domainId, "gateway", "session")).toBe(true);
		expect(service.hasSession(domainId, "gateway", "session")).toBe(false);
		expect(service.deliveryEpoch(address)).not.toBe(pushedUnder);
		expect(answer("forget").outcome).toBe("accepted");
		expect(answersTo("forget")).toEqual(["gateway"]);
		expect(ack(seq, pushedUnder, "delivered").outcome).toBe("delivered");
		expect(service.rows(address, 1, 10)).toEqual([]);
		registry.close();
	});

	it("keeps two lives' epochs apart and hands a held-over row to no later life", () => {
		const { service, registry, push, ack } = world();
		const old = push("old");
		const oldEpoch = service.deliveryEpoch(address);
		service.forgetSession(domainId, "gateway", "session");
		service.upsertSession(domainId, "gateway", "session", session);
		const fresh = push("fresh");
		const freshEpoch = service.deliveryEpoch(address);
		const redelivered = service
			.pendingFor(domainId, "gateway")
			.flatMap((entry) => entry.rows.map((row) => row.seq));
		expect(redelivered).toEqual([fresh]);
		expect(ack(fresh, oldEpoch, "delivered").outcome).toBe("refused");
		expect(ack(old, freshEpoch, "delivered").outcome).toBe("refused");
		expect(ack(fresh, freshEpoch, "delivered").outcome).toBe("delivered");
		expect(ack(old, oldEpoch, "delivered").outcome).toBe("delivered");
		registry.close();
	});

	it("a repeated forget leaves a held-over row its epoch", () => {
		const { service, registry, push, ack } = world();
		const seq = push("op");
		const pushedUnder = service.deliveryEpoch(address);
		service.forgetSession(domainId, "gateway", "session");
		service.forgetSession(domainId, "gateway", "session");
		expect(ack(seq, pushedUnder, "delivered").outcome).toBe("delivered");
		registry.close();
	});

	it("fails a held-over row once its holder's time passes, and not before", () => {
		const clock = 1_000;
		const { service, registry, push, answersTo } = world({ now: () => clock });
		push("slow");
		service.forgetSession(domainId, "gateway", "session");
		service.sweep(clock + INBOX_HOLD_MS);
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		service.sweep(clock + INBOX_HOLD_MS + 1);
		expect(service.rows(address, 1, 10)).toEqual([]);
		expect(answersTo("slow")).toEqual(["router"]);
		expect(service.opResult(domainId, opKey("slow"))).toMatchObject({
			outcome: "failed",
			reason: "session_forgotten",
		});
		registry.close();
	});

	it("fails a held-over row its holder hands back", () => {
		const { service, registry, push, ack } = world();
		const seq = push("back");
		const pushedUnder = service.deliveryEpoch(address);
		service.forgetSession(domainId, "gateway", "session");
		expect(ack(seq, pushedUnder, "waking")).toMatchObject({ outcome: "failed", reason: "session_forgotten" });
		expect(service.rows(address, 1, 10)).toEqual([]);
		registry.close();
	});

	it("holds nothing for a Gateway that went away", () => {
		const { service, registry, push, answersTo, drop } = world();
		push("orphan");
		drop();
		service.forgetSession(domainId, "gateway", "session");
		expect(service.rows(address, 1, 10)).toEqual([]);
		expect(answersTo("orphan")).toEqual(["router"]);
		registry.close();
	});

	it("leaves a held row out of the expiry sweep until its holder lets go", () => {
		let clock = 1_000;
		const { service, registry, land, hand, drop } = world({ now: () => clock });
		const seq = land("aged");
		clock += INBOX_ROW_TTL_MS + 1;
		hand(seq);
		service.sweep(clock);
		expect(service.rows(address, 1, 10)).toHaveLength(1);
		drop();
		service.sweep(clock);
		expect(service.rows(address, 1, 10)).toEqual([]);
		registry.close();
	});

	it("keeps a held-over row fenced across a restart", () => {
		const first = world();
		const seq = first.push("op");
		const pushedUnder = first.service.deliveryEpoch(address);
		first.service.forgetSession(domainId, "gateway", "session");
		first.registry.close();
		const registry = new OwnerStoreRegistry({
			dataDir: first.dataDir,
			ownerOf: () => first.owner.sign.pub,
			quotaFor: () =>
				new DomainQuota({
					dir: first.dataDir,
					limitBytes: 100_000_000,
					statfs: () => ({ available: 100_000_000 }),
				}),
			ambient: processAmbient(),
		});
		const service = new InboxService(registry, {
			signPub: first.router.sign.pub,
			signPriv: first.router.sign.priv,
		});
		const incarnation = service.registerGateway(domainId, "gateway") as number;
		expect(service.pendingFor(domainId, "gateway")).toEqual([]);
		const acked = service.ack({
			address,
			seq,
			deliveryEpoch: pushedUnder,
			outcome: "delivered",
			by: { domainId, gatewayId: "gateway", incarnation },
		});
		expect(acked.outcome).toBe("delivered");
		registry.close();
	});

	it("answers false for a forget whose write did not land", () => {
		const { service, registry, push } = world();
		push("op");
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("fsync uncertain");
		});
		expect(service.forgetSession(domainId, "gateway", "session")).toBe(false);
		fsync.mockRestore();
		registry.close();
	});

	it("takes a Gateway's answer for an op the Router had marked waking", () => {
		const { service, registry, land, answer, answersTo } = world();
		land("late");
		service.markWaking(domainId, opKey("late"));
		expect(answer("late").outcome).toBe("accepted");
		expect(answersTo("late")).toEqual(["gateway"]);
		registry.close();
	});

	it("answers an op once when its row is handed back after its answer landed", () => {
		const { service, registry, push, answer, answersTo, ack } = world();
		const seq = push("twice");
		const first = answer("twice");
		expect(ack(seq, service.deliveryEpoch(address), "waking").outcome).toBe("waking");
		expect(answer("twice").seq).toBe(first.seq);
		expect(answersTo("twice")).toEqual(["gateway"]);
		expect(ack(seq, service.deliveryEpoch(address), "delivered").outcome).toBe("delivered");
		registry.close();
	});

	it("writes no failure over an op its holder already answered", () => {
		const { service, registry, push, answer, answersTo, drop } = world();
		push("done");
		answer("done");
		drop();
		service.forgetSession(domainId, "gateway", "session");
		expect(service.rows(address, 1, 10)).toEqual([]);
		expect(answersTo("done")).toEqual(["gateway"]);
		expect(service.opResult(domainId, opKey("done"))).toMatchObject({ outcome: "accepted" });
		registry.close();
	});
});
