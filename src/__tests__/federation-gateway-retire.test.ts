import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTER_MAX_SKEW_MS, resolveAdmitted, signSelfRevocation } from "../shared/admission.js";
import { type FederationHarness, startFederationHarness } from "../testing/federationHarness.js";

describe("gateway self retirement", () => {
	let h: FederationHarness;
	beforeAll(async () => {
		h = await startFederationHarness();
	}, 30_000);
	afterAll(async () => {
		if (h) await h.close();
	});

	it("refuses invalid records, then retires the registered gateway", async () => {
		const identity = h.set.gateway.identity;
		const other = h.set.console.identity;
		const otherRecord = signSelfRevocation(
			{ signPub: other.sign.pub, issuedAt: h.now(), nonce: "other-key" },
			"other",
			other.sign.priv,
		);
		const wrongKey = await h.gateway.faults.routerInboxCall("gateway_retire", { revocation: otherRecord });
		expect(wrongKey.result).toMatchObject({ ok: false });
		const staleRecord = signSelfRevocation(
			{ signPub: identity.sign.pub, issuedAt: h.now() - REGISTER_MAX_SKEW_MS - 1, nonce: "stale" },
			h.set.gateway.id,
			identity.sign.priv,
		);
		const stale = await h.gateway.faults.routerInboxCall("gateway_retire", { revocation: staleRecord });
		expect(stale.result).toMatchObject({ ok: false });
		const consoleRoad = await h.phone.enroll({ kind: "submit_revocation", revocation: staleRecord });
		expect(consoleRoad.ok).toBe(false);
		const revocation = signSelfRevocation(
			{ signPub: identity.sign.pub, issuedAt: h.now(), nonce: "retire-self" },
			h.set.gateway.id,
			identity.sign.priv,
		);
		const first = await h.gateway.faults.routerInboxCall("gateway_retire", { revocation });
		expect(first.result).toEqual({ ok: true });
		// Evicted once the answer is out: nothing it sends lands.
		const later = await h.gateway.faults.routerInboxCall("gateway_retire", { revocation });
		expect(later.result).not.toEqual({ ok: true });
		const domain = h.router.store.loadDomain(h.set.domain.id);
		expect(domain?.revocations.filter((row) => row.revocation.nonce === "retire-self")).toHaveLength(1);
		expect(
			resolveAdmitted(
				domain?.admissions ?? [],
				domain?.revocations ?? [],
				domain?.ownerSignPub ?? "",
				identity.sign.pub,
			),
		).toBeNull();
	});
});
