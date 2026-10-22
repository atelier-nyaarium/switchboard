import { describe, expect, it } from "vitest";
import { DELETE_SLICE } from "../federation-server/casMutation.js";
import { EnrollmentCoordinator } from "../federation-server/enrollmentCoordinator.js";
import type { EnrollmentState, EnrollmentStore } from "../federation-server/federationSecret.js";
import { GatewayBridge } from "../federation-server/gatewayBridge.js";
import { signAdmission, signRegister, signRevocation, signSelfRevocation } from "../shared/admission.js";
import type { Ambient } from "../shared/ambient.js";
import { processAmbient } from "../shared/ambient.js";
import { generateIdentity } from "../shared/crypto.js";
import { signXDomainLinkEdge, signXDomainLinkRevocation } from "../shared/federation-lifecycle.js";
import { FEDERATION_PROTOCOL_VERSION } from "../shared/router-protocol.js";
import { GATEWAY_ERROR_NOT_ADMITTED } from "../shared/wire-vocabulary.js";

function gatedStore(initial: EnrollmentState) {
	let saved: EnrollmentState | null = structuredClone(initial);
	let gate: Promise<boolean> | null = null;
	let releaseGate: ((commit: boolean) => void) | null = null;
	let writes = 0;
	const store: EnrollmentStore = {
		load: () => (saved ? structuredClone(saved) : null),
		save: (state) => {
			saved = structuredClone(state);
		},
		mutateDomain: async (mutator) => {
			const decision = mutator(saved ? structuredClone(saved) : null);
			if (!decision.commit) return decision.value;
			writes += 1;
			const held = gate;
			gate = null;
			if (held && !(await held)) throw new Error();
			saved = decision.next === DELETE_SLICE ? null : structuredClone(decision.next);
			return decision.value;
		},
	};
	return {
		store,
		get saved() {
			return saved ? structuredClone(saved) : null;
		},
		get writes() {
			return writes;
		},
		holdNextWrite() {
			gate = new Promise<boolean>((resolve) => {
				releaseGate = resolve;
			});
			return (commit: boolean) => releaseGate?.(commit);
		},
	};
}

function seed(
	owner: ReturnType<typeof generateIdentity>,
	gateway: ReturnType<typeof generateIdentity>,
): EnrollmentState {
	const issuedAt = Date.now() - 10_000;
	const admission = signAdmission(
		{
			kind: "gateway",
			signPub: gateway.sign.pub,
			boxPub: gateway.box.pub,
			gatewayId: "laptop",
			issuedAt,
			nonce: "admission-nonce",
		},
		owner.sign.priv,
		owner.sign.pub,
	);
	return { ownerSignPub: owner.sign.pub, ownerBoxPub: owner.box.pub, admissions: [admission], revocations: [] };
}

function registerParams(
	owner: ReturnType<typeof generateIdentity>,
	gateway: ReturnType<typeof generateIdentity>,
	nonce: string,
) {
	const proofAt = Date.now();
	const admission = signAdmission(
		{
			kind: "gateway",
			signPub: gateway.sign.pub,
			boxPub: gateway.box.pub,
			gatewayId: "laptop",
			issuedAt: proofAt - 10_000,
			nonce: `registration-${nonce}`,
		},
		owner.sign.priv,
		owner.sign.pub,
	);
	return {
		domainId: "alice",
		gatewayId: "laptop",
		protocolVersion: FEDERATION_PROTOCOL_VERSION,
		signPub: gateway.sign.pub,
		boxPub: gateway.box.pub,
		admission: JSON.stringify(admission),
		proof: signRegister("laptop", proofAt, nonce, gateway.sign.priv),
		proofAt,
		proofNonce: nonce,
	};
}

function bridgeFor(coordinator: EnrollmentCoordinator) {
	const ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer"> = processAmbient();
	return new GatewayBridge({
		port: 0,
		authToken: "test",
		getDomain: () => coordinator.getDomainSnapshot(),
		getDomainMeta: () => null,
		hasLinkEdge: () => false,
		adminDomainId: () => null,
		ambient,
	});
}

describe("pending enrollment revocations", () => {
	it.each(["owner", "self"] as const)("fences %s revocation through failure and retry", async (kind) => {
		const owner = generateIdentity();
		const gateway = generateIdentity();
		const held = gatedStore(seed(owner, gateway));
		const coordinator = new EnrollmentCoordinator(generateIdentity(), held.store, "alice", processAmbient());
		const bridge = bridgeFor(coordinator);
		const initial = await bridge.handleCall(
			"conn-1",
			"gateway_register",
			registerParams(owner, gateway, "initial"),
		);
		expect(initial).toMatchObject({ ok: true });
		const frame = () => bridge.handleCall("conn-1", "inbox_ack", { incarnation: 1 });
		const revocation =
			kind === "owner"
				? signRevocation(
						{ signPub: gateway.sign.pub, issuedAt: Date.now(), nonce: "revoke-owner" },
						owner.sign.priv,
						owner.sign.pub,
					)
				: signSelfRevocation(
						{ signPub: gateway.sign.pub, issuedAt: Date.now(), nonce: "revoke-self" },
						"laptop",
						gateway.sign.priv,
					);
		const release = held.holdNextWrite();
		const pending =
			kind === "owner"
				? coordinator.revoke(revocation)
				: coordinator.retire(revocation, { gatewayId: "laptop", signPub: gateway.sign.pub });

		await expect(frame()).resolves.toEqual({ ok: false, error: GATEWAY_ERROR_NOT_ADMITTED });
		const reconnect = await bridge.handleCall(
			"conn-2",
			"gateway_register",
			registerParams(owner, gateway, "pending-reconnect"),
		);
		expect(reconnect).toMatchObject({ ok: false });

		release(false);
		await expect(pending).rejects.toThrow();
		await expect(frame()).resolves.toEqual({ ok: false, error: GATEWAY_ERROR_NOT_ADMITTED });
		const afterFailure = await bridge.handleCall(
			"conn-3",
			"gateway_register",
			registerParams(owner, gateway, "failed-reconnect"),
		);
		expect(afterFailure).toMatchObject({ ok: false });

		const retry =
			kind === "owner"
				? coordinator.revoke(revocation)
				: coordinator.retire(revocation, { gatewayId: "laptop", signPub: gateway.sign.pub });
		await expect(retry).resolves.toBeNull();
		expect(held.writes).toBe(2);
		expect(held.saved?.revocations).toContainEqual(revocation);
		await expect(frame()).resolves.toEqual({ ok: false, error: GATEWAY_ERROR_NOT_ADMITTED });
	});

	it.each(["signed", "unsigned"] as const)("keeps a %s edge removal fenced after a failed write", async (kind) => {
		const owner = generateIdentity();
		const edge = signXDomainLinkEdge(
			{ srcDomainId: "alice", dstDomainId: "friend", issuedAt: 1000, nonce: "edge-nonce" },
			owner.sign.priv,
			owner.sign.pub,
		);
		const state: EnrollmentState = {
			ownerSignPub: owner.sign.pub,
			ownerBoxPub: owner.box.pub,
			admissions: [],
			revocations: [],
			linkEdges: [edge],
		};
		const held = gatedStore(state);
		const coordinator = new EnrollmentCoordinator(generateIdentity(), held.store, "alice", processAmbient());
		expect(coordinator.hasLinkEdge("alice", "friend")).toBe(true);
		const release = held.holdNextWrite();
		const removal =
			kind === "signed"
				? coordinator.removeLinkEdge(
						signXDomainLinkRevocation(
							{ srcDomainId: "alice", dstDomainId: "friend", revokedAt: 2000, nonce: "revoke-nonce" },
							owner.sign.priv,
							owner.sign.pub,
						),
					)
				: coordinator.dropLinkEdge("friend");

		expect(coordinator.hasLinkEdge("alice", "friend")).toBe(false);
		expect(coordinator.linkEdgeId("alice", "friend")).toBeNull();
		release(false);
		if (kind === "signed") await expect(removal).rejects.toThrow();
		else await expect(removal).resolves.toBe("durability_failure");
		expect(coordinator.hasLinkEdge("alice", "friend")).toBe(false);
		expect(coordinator.linkEdgeId("alice", "friend")).toBeNull();
	});
});
