import { describe, expect, it } from "vitest";
import {
	dispatchEnrollOp,
	EnrollmentCoordinator,
	inMemoryEnrollmentStore,
	resolveEnrollRoute,
	sanitizeDomainId,
} from "../federation-server/enrollmentCoordinator.js";
import type { FederationSecret } from "../federation-server/federationSecret.js";
import { FileSecretStore } from "../federation-server/fileSecretStore.js";
import type { SecretIO } from "../federation-server/secretIO.js";
import { signAdmission, signRevocation } from "../shared/admission.js";
import { processAmbient } from "../shared/ambient.js";
import { generateIdentity } from "../shared/crypto.js";
import { signXDomainLinkEdge } from "../shared/federation-lifecycle.js";

const router = generateIdentity();
const now = 1_000_000;

function fakeMultiDomainIO(): SecretIO {
	let stored: FederationSecret | null = null;
	let version = 0;
	return {
		read: async () => (stored ? { value: stored, resourceVersion: String(version) } : null),
		write: async (v) => {
			stored = v;
			version += 1;
		},
	};
}

describe("resolveEnrollRoute (multi-tenant owner-fact routing)", () => {
	const adminOwner = generateIdentity();
	const guestOwner = generateIdentity();
	const deps = {
		adminDomainId: "admin-dom",
		rootedDomainFor: (key: string) =>
			key === adminOwner.sign.pub ? "admin-dom" : key === guestOwner.sign.pub ? "guest-dom" : null,
	};

	function gatewayAdmission(signer: ReturnType<typeof generateIdentity>) {
		const subject = generateIdentity();
		return signAdmission(
			{
				kind: "gateway" as const,
				signPub: subject.sign.pub,
				boxPub: subject.box.pub,
				gatewayId: "laptop",
				issuedAt: 1000,
				nonce: "bm9uY2U=",
			},
			signer.sign.priv,
			signer.sign.pub,
		);
	}

	it("routes an admission to the Domain its signer roots, never an assumed admin Domain", async () => {
		const guest = gatewayAdmission(guestOwner);
		expect(resolveEnrollRoute({ kind: "submit_admission", admission: guest }, deps)).toEqual({
			kind: "domain",
			domainId: "guest-dom",
		});
		const admin = gatewayAdmission(adminOwner);
		expect(resolveEnrollRoute({ kind: "submit_admission", admission: admin }, deps)).toEqual({
			kind: "domain",
			domainId: "admin-dom",
		});
	});

	it("a signer rooting no Domain is refused with the same wording as a bad signature", async () => {
		const stranger = gatewayAdmission(generateIdentity());
		expect(resolveEnrollRoute({ kind: "submit_admission", admission: stranger }, deps)).toMatchObject({
			kind: "refused",
		});
		const revocation = signRevocation(
			{ signPub: generateIdentity().sign.pub, issuedAt: 1000, nonce: "bm9uY2U=" },
			guestOwner.sign.priv,
			guestOwner.sign.pub,
		);
		expect(resolveEnrollRoute({ kind: "submit_revocation", revocation }, deps)).toEqual({
			kind: "domain",
			domainId: "guest-dom",
		});
		const strangerId = generateIdentity();
		const strangerRevocation = signRevocation(
			{ signPub: generateIdentity().sign.pub, issuedAt: 1000, nonce: "bm9uY2U=" },
			strangerId.sign.priv,
			strangerId.sign.pub,
		);
		expect(resolveEnrollRoute({ kind: "submit_revocation", revocation: strangerRevocation }, deps)).toMatchObject({
			kind: "refused",
		});
	});

	it("link edges route by srcDomainId, tenant ops by admin Domain, delete_domain to the tenant authority", async () => {
		const edge = signXDomainLinkEdge(
			{ srcDomainId: "guest-dom", dstDomainId: "admin-dom", issuedAt: 1000, nonce: "bm9uY2U=" },
			guestOwner.sign.priv,
			guestOwner.sign.pub,
		);
		expect(resolveEnrollRoute({ kind: "submit_xdomain_link", edge }, deps)).toEqual({
			kind: "domain",
			domainId: "guest-dom",
		});
		const rename = { kind: "set_display_name" as const, rename: {} as never };
		expect(resolveEnrollRoute(rename, deps)).toEqual({ kind: "domain", domainId: "admin-dom" });
		expect(resolveEnrollRoute(rename, { ...deps, adminDomainId: null })).toMatchObject({ kind: "refused" });
		expect(resolveEnrollRoute({ kind: "delete_domain", deletion: {} as never }, deps)).toEqual({
			kind: "tenant-authority",
		});
	});

	it("a guest admission lands in the guest coordinator; the admin coordinator (the old routing) rejects it", async () => {
		const adminC = new EnrollmentCoordinator(router, inMemoryEnrollmentStore(), "admin-dom", processAmbient());
		const pa = adminC.mintEnrollOwner("admin-dom", "https://router", now);
		await adminC.redeemEnrollOwner(pa.nonce, adminOwner.sign.pub, adminOwner.box.pub, now);
		const guestC = new EnrollmentCoordinator(router, inMemoryEnrollmentStore(), "guest-dom", processAmbient());
		const pg = guestC.mintEnrollOwner("guest-dom", "https://router", now);
		await guestC.redeemEnrollOwner(pg.nonce, guestOwner.sign.pub, guestOwner.box.pub, now);

		const op = { kind: "submit_admission" as const, admission: gatewayAdmission(guestOwner) };
		const route = resolveEnrollRoute(op, deps);
		expect(route).toEqual({ kind: "domain", domainId: "guest-dom" });
		expect(await dispatchEnrollOp(guestC, op)).toEqual({ ok: true });
		expect(guestC.getDomainSnapshot()?.admissions).toHaveLength(1);
		expect(await dispatchEnrollOp(adminC, op)).toMatchObject({ ok: false });
	});
});

describe("EnrollmentCoordinator domain isolation over one store", () => {
	it("two Domains over distinct store slices root at independent owners + persist apart", async () => {
		const io = fakeMultiDomainIO();
		const store = new FileSecretStore("/tmp", io);
		await store.init();
		const ownerAdmin = generateIdentity();
		const ownerWork = generateIdentity();
		const admin = new EnrollmentCoordinator(router, store.domainStore("alice"), "alice", processAmbient());
		const work = new EnrollmentCoordinator(router, store.domainStore("work"), "work", processAmbient());
		const ph = admin.mintEnrollOwner("alice", "https://router", now);
		await admin.redeemEnrollOwner(ph.nonce, ownerAdmin.sign.pub, ownerAdmin.box.pub, now);
		const pw = work.mintEnrollOwner("work", "https://router", now);
		await work.redeemEnrollOwner(pw.nonce, ownerWork.sign.pub, ownerWork.box.pub, now);
		expect(admin.getDomainSnapshot()?.ownerSignPub).toBe(ownerAdmin.sign.pub);
		expect(work.getDomainSnapshot()?.ownerSignPub).toBe(ownerWork.sign.pub);
		expect(admin.getDomainSnapshot()?.ownerSignPub).not.toBe(work.getDomainSnapshot()?.ownerSignPub);
		await new Promise((r) => setTimeout(r, 20));
		const reloaded = new FileSecretStore("/tmp", io);
		await reloaded.init();
		expect(reloaded.loadDomain("alice")?.ownerSignPub).toBe(ownerAdmin.sign.pub);
		expect(reloaded.loadDomain("work")?.ownerSignPub).toBe(ownerWork.sign.pub);
	});
});

describe("sanitizeDomainId", () => {
	it("slugs to lower-case alphanumerics with single dashes", async () => {
		expect(sanitizeDomainId("My Lab")).toBe("my-lab");
		expect(sanitizeDomainId("ACME_Corp.1")).toBe("acme-corp-1");
	});

	it("trims dash runs and collapses the qualifier separator", async () => {
		expect(sanitizeDomainId("--alice--")).toBe("alice");
		expect(sanitizeDomainId("a/b")).toBe("a-b");
	});

	it("throws on empty / all-separator / nullish input (no silent fallback)", async () => {
		expect(() => sanitizeDomainId("")).toThrow();
		expect(() => sanitizeDomainId("///")).toThrow();
		expect(() => sanitizeDomainId(undefined)).toThrow();
		expect(() => sanitizeDomainId(null)).toThrow();
	});
});
