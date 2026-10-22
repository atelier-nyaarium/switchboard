import { describe, expect, it, vi } from "vitest";
import { EnrollmentCoordinator, inMemoryEnrollmentStore } from "../federation-server/enrollmentCoordinator.js";
import { RouterServer } from "../federation-server/routerServer.js";
import type { ShareService } from "../federation-server/share/shareService.js";
import { processAmbient } from "../shared/ambient.js";
import { generateIdentity } from "../shared/crypto.js";
import type { EnrollResult } from "../shared/federation-enroll-ops.js";
import { type EnrollOp, signXDomainLinkRevocation } from "../shared/federation-lifecycle.js";

describe("revoke link outcome", () => {
	it("returns the share unlink outcome", async () => {
		const owner = generateIdentity();
		const coordinator = new EnrollmentCoordinator(
			generateIdentity(),
			inMemoryEnrollmentStore({
				ownerSignPub: owner.sign.pub,
				ownerBoxPub: owner.box.pub,
				admissions: [],
				revocations: [],
			}),
			"admin",
			processAmbient(),
		);
		const unlink = vi.fn<ShareService["unlink"]>().mockResolvedValue({
			peersRemoved: 0,
			sharesDropped: 0,
			jobsExpired: 0,
			outcome: "durability_uncertain",
		});
		const server = Object.assign(Object.create(RouterServer.prototype), {
			params: { store: { adminDomainId: () => "admin", listDomains: () => [] } },
			ownerServices: { share: { unlink }, presence: { refresh: vi.fn() } },
			coordinatorFor: () => coordinator,
			flushOrError: async () => null,
		}) as unknown as { handleEnrollOp(op: EnrollOp): Promise<EnrollResult> };
		const revocation = signXDomainLinkRevocation(
			{
				srcDomainId: "admin",
				dstDomainId: "friend",
				revokedAt: Date.now(),
				nonce: "unlink-outcome",
			},
			owner.sign.priv,
			owner.sign.pub,
		);

		const result = await server.handleEnrollOp({ kind: "revoke_xdomain_link", revocation });

		expect(unlink).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true, outcome: "durability_uncertain" });
	});
});
