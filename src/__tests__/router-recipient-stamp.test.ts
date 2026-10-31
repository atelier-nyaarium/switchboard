import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboxFrames } from "../federation-server/bridge/inboxFrames.js";
import type { GatewayRegistration } from "../federation-server/gatewayBridge.js";
import { InboxService } from "../federation-server/inbox/inboxService.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { createPhoneHoldService } from "../federation-server/phone/phoneHoldService.js";
import { processAmbient } from "../shared/ambient.js";
import { generateIdentity } from "../shared/crypto.js";
import {
	formatInboxAddress,
	type InboxAddress,
	type InboxRowInput,
	signRowEnvelope,
	verifyRowEnvelope,
} from "../shared/schemasInbox.js";
import { PHONE_HOLD_WINDOW_MS } from "../shared/schemasPhoneHold.js";

const domainId = "domain";
const roots: string[] = [];
const registries: OwnerStoreRegistry[] = [];

function make() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-recipient-stamp-"));
	roots.push(dataDir);
	let now = 10_000;
	const owner = generateIdentity();
	const gateway = generateIdentity();
	const router = generateIdentity();
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (id) => (id === domainId ? owner.sign.pub : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => now },
	});
	registries.push(registry);
	const inbox = new InboxService(registry, { signPub: router.sign.pub, signPriv: router.sign.priv });
	const hold = createPhoneHoldService({ registry });
	const baseAmbient = processAmbient();
	const frames = new InboxFrames({
		inbox,
		ambient: { ...baseAmbient, now: () => now },
		hasLinkEdge: () => false,
		getDomain: () => null,
		isMigrationFenced: () => false,
		getRegistration: () => undefined,
		getConnectionId: () => undefined,
		getConnection: () => null as never,
		send: () => false,
		notifySessionForgotten: () => {},
	});
	frames.setPhoneHoldReader((id, at) => hold.read(id, at));
	const pushed: ReturnType<typeof inbox.rows> = [];
	frames.setOwnerRowPush((_id, row) => pushed.push(row));
	const address: InboxAddress = { kind: "owner", domainId, ownerSignPub: owner.sign.pub };
	const reg: GatewayRegistration = {
		domainId,
		gatewayId: "gateway",
		signPub: gateway.sign.pub,
		incarnation: 1,
	};
	const row = (opId: string): InboxRowInput => {
		const envelope = {
			origin: { kind: "gateway" as const, domainId, gatewayId: "gateway" },
			opKey: { conversationId: "assistant", opId },
			epoch: 1,
			kind: "plugin_action" as const,
			contentRefs: [],
			recipient: { kind: "holder" as const },
		};
		return {
			envelope,
			producerSig: signRowEnvelope(envelope, gateway.sign.priv),
			body: {
				v: 1,
				epoch: 1,
				nonce: Buffer.alloc(12, 1).toString("base64"),
				ciphertext: Buffer.alloc(16, 2).toString("base64"),
			},
		};
	};
	const append = (input: unknown) =>
		frames.appendRow(reg, {
			address: formatInboxAddress(address),
			row: input,
			incarnation: 1,
		});
	return {
		dataDir,
		registry,
		inbox,
		frames,
		hold,
		pushed,
		address,
		gateway,
		row,
		append,
		setNow: (value: number) => (now = value),
	};
}

afterEach(() => {
	for (const registry of registries.splice(0)) registry.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Router holder recipient", () => {
	it("stamps the holder beside the signed envelope and replays that stamp", () => {
		const harness = make();
		const input = harness.row("request-1");
		harness.hold.claim(domainId, "phone-a", 10_000);

		const answer = harness.append(input) as {
			outcome: string;
			result?: { stamp?: { device: string } };
		};
		const stored = harness.inbox.rows(harness.address, 1, 1)[0];
		expect(answer).toMatchObject({
			opKey: { conversationId: "assistant", opId: "request-1" },
			outcome: "accepted",
			seq: 1,
			result: { stamp: { device: "phone-a" } },
		});
		expect(stored.stamp).toEqual({ device: "phone-a" });
		expect(stored.envelope).toEqual(input.envelope);
		expect(verifyRowEnvelope(stored.envelope, stored.producerSig, harness.gateway.sign.pub)).toBe(true);
		expect(harness.pushed[0]?.stamp).toEqual({ device: "phone-a" });

		harness.setNow(10_001);
		harness.hold.claim(domainId, "phone-b", 10_001);
		const replay = harness.append(input) as typeof answer;
		expect(replay.result?.stamp).toEqual({ device: "phone-a" });
		expect(harness.inbox.rows(harness.address, 1, 10)).toHaveLength(1);
		expect(harness.pushed).toHaveLength(1);
	});

	it("refuses a holder recipient when no phone holds", () => {
		const harness = make();
		const answer = harness.append(harness.row("request-2"));
		expect(answer).toEqual({
			opKey: { conversationId: "assistant", opId: "request-2" },
			outcome: "refused",
			reason: "no_holder",
		});
		expect(harness.inbox.rows(harness.address, 1, 10)).toEqual([]);
	});

	it("replays an accepted holder append after the hold lapses", () => {
		const harness = make();
		const input = harness.row("request-lapsed-retry");
		harness.hold.claim(domainId, "phone-a", 10_000);
		expect(harness.append(input)).toMatchObject({ outcome: "accepted", result: { stamp: { device: "phone-a" } } });

		harness.setNow(10_000 + PHONE_HOLD_WINDOW_MS);
		expect(harness.hold.read(domainId, 10_000 + PHONE_HOLD_WINDOW_MS)).toBeNull();
		expect(harness.append(input)).toMatchObject({
			outcome: "accepted",
			seq: 1,
			result: { stamp: { device: "phone-a" } },
		});
		expect(harness.inbox.rows(harness.address, 1, 10)).toHaveLength(1);
	});

	it("refuses a holder recipient addressed to a session", () => {
		const harness = make();
		harness.hold.claim(domainId, "phone-a", 10_000);
		const answer = harness.frames.appendRow(
			{ domainId, gatewayId: "gateway", signPub: harness.gateway.sign.pub, incarnation: 1 },
			{
				address: formatInboxAddress({ kind: "session", domainId, gatewayId: "gateway", sessionId: "s1" }),
				row: harness.row("request-session"),
				incarnation: 1,
			},
		);
		expect(answer).toEqual({ ok: false, error: "refused", reason: "recipient" });
	});

	it("refuses a producer-supplied stamp", () => {
		const harness = make();
		harness.hold.claim(domainId, "phone-a", 10_000);
		const input = { ...harness.row("request-3"), stamp: { device: "phone-spoof" } };

		expect(harness.append(input)).toEqual({ ok: false, error: "invalid inbox_append" });
		expect(harness.inbox.rows(harness.address, 1, 10)).toEqual([]);
	});
});
