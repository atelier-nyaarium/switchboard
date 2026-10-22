import { describe, expect, it } from "vitest";
import type { DomainMutation } from "../federation-server/casMutation.js";
import { EnrollmentCoordinator, inMemoryEnrollmentStore } from "../federation-server/enrollmentCoordinator.js";
import type { EnrollmentState, EnrollmentStore } from "../federation-server/federationSecret.js";
import { signAdmission, signRevocation, signSelfRevocation } from "../shared/admission.js";
import { processAmbient } from "../shared/ambient.js";
import { generateIdentity } from "../shared/crypto.js";

const router = generateIdentity();
const owner = generateIdentity();
const now = 1_000_000;

function coordinator(initial?: EnrollmentState) {
	return new EnrollmentCoordinator(router, inMemoryEnrollmentStore(initial), "alice", processAmbient());
}

describe("EnrollmentCoordinator enroll-owner", () => {
	it("mint then redeem roots the Domain at the owner key", async () => {
		const c = coordinator();
		expect(c.rooted).toBe(false);
		expect(c.getDomainSnapshot()).toBeNull();
		const payload = c.mintEnrollOwner("alice", "https://router", now);
		expect(payload.routerSignPub).toBe(router.sign.pub);
		const denied = await c.redeemEnrollOwner(payload.nonce, owner.sign.pub, owner.box.pub, now + 1000);
		expect(denied).toBeNull();
		expect(c.rooted).toBe(true);
		expect(c.getDomainSnapshot()).toMatchObject({ ownerSignPub: owner.sign.pub });
	});

	it("rejects an unknown nonce", async () => {
		const c = coordinator();
		expect(await c.redeemEnrollOwner("never-minted", owner.sign.pub, owner.box.pub, now)).not.toBeNull();
		expect(c.rooted).toBe(false);
	});

	it("rejects an expired nonce", async () => {
		const c = coordinator();
		const payload = c.mintEnrollOwner("alice", "https://router", now);
		const denied = await c.redeemEnrollOwner(payload.nonce, owner.sign.pub, owner.box.pub, now + 600_001);
		expect(denied).not.toBeNull();
		expect(c.rooted).toBe(false);
	});

	it("a nonce is single-use", async () => {
		const c = coordinator();
		const payload = c.mintEnrollOwner("alice", "https://router", now);
		expect(await c.redeemEnrollOwner(payload.nonce, owner.sign.pub, owner.box.pub, now)).toBeNull();
		const second = generateIdentity();
		expect(await c.redeemEnrollOwner(payload.nonce, second.sign.pub, second.box.pub, now)).toMatch(
			/already-redeemed/,
		);
		expect(c.getDomainSnapshot()?.ownerSignPub).toBe(owner.sign.pub);
	});

	it("refuses to re-root at a different owner", async () => {
		const c = coordinator();
		const p1 = c.mintEnrollOwner("alice", "https://router", now);
		await c.redeemEnrollOwner(p1.nonce, owner.sign.pub, owner.box.pub, now);
		const intruder = generateIdentity();
		const p2 = c.mintEnrollOwner("alice", "https://router", now);
		expect(await c.redeemEnrollOwner(p2.nonce, intruder.sign.pub, intruder.box.pub, now)).toMatch(
			/different owner/,
		);
		expect(c.getDomainSnapshot()?.ownerSignPub).toBe(owner.sign.pub);
	});

	it("fires the QR cleanup when the nonce is redeemed", async () => {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://router", now);
		let deleted = false;
		c.registerNonceCleanup(p.nonce, () => {
			deleted = true;
		});
		expect(await c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now)).toBeNull();
		expect(deleted).toBe(true);
	});

	it("fires the cleanup even on an expired redeem (the QR is dead either way)", async () => {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://router", now);
		let deleted = false;
		c.registerNonceCleanup(p.nonce, () => {
			deleted = true;
		});
		expect(await c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now + 600_001)).not.toBeNull();
		expect(deleted).toBe(true);
	});

	it("a throwing cleanup does not break redeem", async () => {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://router", now);
		c.registerNonceCleanup(p.nonce, () => {
			throw new Error("DM already gone");
		});
		expect(await c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now)).toBeNull();
		expect(c.rooted).toBe(true);
	});
});

describe("EnrollmentCoordinator allowlist", () => {
	function admission(gatewayId: string) {
		return {
			kind: "gateway" as const,
			signPub: generateIdentity().sign.pub,
			boxPub: generateIdentity().box.pub,
			gatewayId,
			issuedAt: 1000,
			nonce: "bm9uY2U=",
		};
	}

	it("admit before rooting is refused", async () => {
		const c = coordinator();
		const signed = signAdmission(admission("laptop"), owner.sign.priv, owner.sign.pub);
		expect(await c.admit(signed)).not.toBeNull();
	});

	it("admits an owner-signed admission and surfaces revocations in the trust", async () => {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://router", now);
		await c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		const signed = signAdmission(admission("laptop"), owner.sign.priv, owner.sign.pub);
		expect(await c.admit(signed)).toBeNull();
		const attacker = generateIdentity();
		const forged = signAdmission(admission("laptop"), attacker.sign.priv, attacker.sign.pub);
		expect(await c.admit(forged)).not.toBeNull();
	});

	async function rooted() {
		const c = coordinator();
		const p = c.mintEnrollOwner("alice", "https://router", now);
		await c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		return c;
	}

	function failingOnceStore(initial: EnrollmentState): EnrollmentStore {
		const durable = inMemoryEnrollmentStore(initial);
		let fail = true;
		return {
			load: () => durable.load(),
			save: (state) => durable.save(state),
			mutateDomain: async <T>(mutator: (current: EnrollmentState | null) => DomainMutation<T>): Promise<T> => {
				if (fail) {
					fail = false;
					throw new Error();
				}
				return durable.mutateDomain(mutator);
			},
		};
	}

	it("keeps a failed revocation in the deny overlay", async () => {
		const initial = { ownerSignPub: owner.sign.pub, ownerBoxPub: null, admissions: [], revocations: [] };
		const store = failingOnceStore(initial);
		const c = new EnrollmentCoordinator(router, store, "alice", processAmbient());
		const signed = signRevocation(
			{ signPub: generateIdentity().sign.pub, issuedAt: 1, nonce: "cmV2b2tl" },
			owner.sign.priv,
			owner.sign.pub,
		);

		await expect(c.revoke(signed)).rejects.toBeInstanceOf(Error);
		expect(c.getDomainSnapshot()?.revocations).toContainEqual(signed);
		expect(store.load()?.revocations).toHaveLength(0);
	});

	it("writes a retried admission after its first write fails", async () => {
		const initial = { ownerSignPub: owner.sign.pub, ownerBoxPub: null, admissions: [], revocations: [] };
		const store = failingOnceStore(initial);
		const c = new EnrollmentCoordinator(router, store, "alice", processAmbient());
		const signed = signAdmission(admission("laptop"), owner.sign.priv, owner.sign.pub);

		await expect(c.admit(signed)).rejects.toBeInstanceOf(Error);
		expect(store.load()?.admissions).toHaveLength(0);
		expect(await c.admit(signed)).toBeNull();
		expect(store.load()?.admissions).toHaveLength(1);
	});

	it("rejects a structurally-invalid admission even when owner-signed", async () => {
		const c = await rooted();
		const id = generateIdentity();
		const hostNoId = signAdmission(
			{ kind: "gateway", signPub: id.sign.pub, boxPub: id.box.pub, issuedAt: 1, nonce: "YQ==" },
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(await c.admit(hostNoId)).not.toBeNull();
		const deviceWithHost = signAdmission(
			{ kind: "console", signPub: id.sign.pub, boxPub: id.box.pub, gatewayId: "x", issuedAt: 1, nonce: "Yg==" },
			owner.sign.priv,
			owner.sign.pub,
		);
		expect(await c.admit(deviceWithHost)).not.toBeNull();
	});

	it("is idempotent: a re-submitted admission does not duplicate", async () => {
		const c = await rooted();
		const signed = signAdmission(admission("laptop"), owner.sign.priv, owner.sign.pub);
		expect(await c.admit(signed)).toBeNull();
		expect(await c.admit(signed)).toBeNull();
		expect(c.getDomainSnapshot()?.admissions).toHaveLength(1);
	});

	it("stores a gateway's own retirement once however often it is sent", async () => {
		const c = await rooted();
		const gateway = generateIdentity();
		const admitted = { ...admission("laptop"), signPub: gateway.sign.pub, boxPub: gateway.box.pub };
		expect(await c.admit(signAdmission(admitted, owner.sign.priv, owner.sign.pub))).toBeNull();
		const retirement = signSelfRevocation(
			{ signPub: gateway.sign.pub, issuedAt: Date.now(), nonce: "retire" },
			"laptop",
			gateway.sign.priv,
		);
		const registered = { gatewayId: "laptop", signPub: gateway.sign.pub };

		expect(await c.retire(retirement, registered)).toBeNull();
		expect(await c.retire(retirement, registered)).toBeNull();

		expect(c.getDomainSnapshot()?.revocations).toHaveLength(1);
	});

	it("persists the root so a reloaded coordinator is already rooted", async () => {
		const store = inMemoryEnrollmentStore();
		const c1 = new EnrollmentCoordinator(router, store, "alice", processAmbient());
		const p = c1.mintEnrollOwner("alice", "https://router", now);
		await c1.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		const c2 = new EnrollmentCoordinator(router, store, "alice", processAmbient());
		expect(c2.rooted).toBe(true);
		expect(c2.getDomainSnapshot()?.ownerSignPub).toBe(owner.sign.pub);
	});
});

describe("EnrollmentCoordinator domain status + display name (friend onboarding)", () => {
	it("getDomainStatus reflects unrooted / pending / rooted", async () => {
		const unrooted = new EnrollmentCoordinator(router, inMemoryEnrollmentStore(), "alice", processAmbient());
		expect(unrooted.getDomainStatus()).toBe("unrooted");
		expect(unrooted.displayName).toBeNull();

		const pending = new EnrollmentCoordinator(
			router,
			inMemoryEnrollmentStore({
				ownerSignPub: null,
				ownerBoxPub: null,
				admissions: [],
				revocations: [],
				displayName: "Carol",
				pendingTenant: { displayName: "Carol", nonce: "aW52aXRl", issuedAt: 1, ttlMs: 60_000, rooted: false },
			}),
			"alice",
			processAmbient(),
		);
		expect(pending.getDomainStatus()).toBe("pending");
		expect(pending.displayName).toBe("Carol");
		expect(pending.getDomainSnapshot()).toBeNull();

		const c = new EnrollmentCoordinator(router, inMemoryEnrollmentStore(), "alice", processAmbient());
		const p = c.mintEnrollOwner("alice", "https://router", now);
		await c.redeemEnrollOwner(p.nonce, owner.sign.pub, owner.box.pub, now);
		expect(c.getDomainStatus()).toBe("rooted");
	});

	it("getDomainSnapshot carries the displayName once rooted", async () => {
		const c = new EnrollmentCoordinator(
			router,
			inMemoryEnrollmentStore({
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [],
				revocations: [],
				displayName: "Nyaarium",
			}),
			"alice",
			processAmbient(),
		);
		expect(c.getDomainSnapshot()?.displayName).toBe("Nyaarium");
		expect(c.displayName).toBe("Nyaarium");
	});
});
