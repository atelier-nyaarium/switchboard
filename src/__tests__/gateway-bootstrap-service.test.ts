import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createGatewayBootstrapService,
	MAX_BOOTSTRAPS_PER_DOMAIN,
} from "../federation-server/enroll/gatewayBootstrapService.js";
import type { GatewayRegistration } from "../federation-server/gatewayBridge.js";
import type { OwnerServiceHooks } from "../federation-server/ownerServiceHooks.js";
import { type DomainSnapshot, signAdmission, signRevocation } from "../shared/admission.js";
import { generateIdentity, type Identity, seal } from "../shared/crypto.js";
import { bootstrapPickupId, signBootstrapAsk } from "../shared/gateway-bootstrap.js";
import { EnrollGatewayPayloadSchema } from "../shared/schemasEnrollSetup.js";
import type { GatewayBootstrapFrame } from "../shared/schemasGatewayBootstrap.js";

function domainOf(owner: Identity, gateways: Identity[], revoked: Identity[] = []): DomainSnapshot {
	return {
		ownerSignPub: owner.sign.pub,
		admissions: gateways.map((gateway, index) =>
			signAdmission(
				{
					kind: "gateway",
					signPub: gateway.sign.pub,
					boxPub: gateway.box.pub,
					gatewayId: `gw-${index}`,
					issuedAt: 1000,
					nonce: `adm-${index}`,
				},
				owner.sign.priv,
				owner.sign.pub,
			),
		),
		revocations: revoked.map((gateway) =>
			signRevocation(
				{ signPub: gateway.sign.pub, issuedAt: 2000, nonce: "rev" },
				owner.sign.priv,
				owner.sign.pub,
			),
		),
	};
}

function frameFrom(sender: Identity, gateway: Identity, bytes = 64): GatewayBootstrapFrame {
	return {
		v: 1,
		signerSignPub: sender.sign.pub,
		sealed: seal(Buffer.alloc(bytes, 7), gateway.box.pub, sender.sign.priv),
	};
}

function world() {
	let now = 1_000_000;
	const domains = new Map<string, DomainSnapshot>();
	const registered: Array<(reg: GatewayRegistration) => void> = [];
	const service = createGatewayBootstrapService({
		ambient: { now: () => now },
		getDomain: (domainId) => domains.get(domainId) ?? null,
	});
	service.register({
		ownerOp: () => {},
		onGatewayRegistered: (listener: (reg: GatewayRegistration) => void) => registered.push(listener),
	} as unknown as OwnerServiceHooks);
	return {
		service,
		domains,
		advance: (ms: number) => {
			now += ms;
		},
		registers: (domainId: string, gateway: Identity) => {
			for (const listener of registered) {
				listener({ domainId, gatewayId: "gw", signPub: gateway.sign.pub, incarnation: 1 });
			}
		},
	};
}

describe("the pickup id", () => {
	it("is what the shared vectors pin for both runtimes", () => {
		const { cases, payload } = JSON.parse(
			fs.readFileSync("tests/fixtures/gateway-bootstrap/vectors.json", "utf8"),
		) as {
			cases: Array<{ code: string; pickupId: string }>;
			payload: { text: string; pickupId: string };
		};
		expect(cases.length).toBeGreaterThan(0);
		for (const { code, pickupId } of cases) expect(bootstrapPickupId(code)).toBe(pickupId);
		// The code as a Gateway shows it.
		const shown = EnrollGatewayPayloadSchema.parse(JSON.parse(payload.text));
		expect(bootstrapPickupId(shown.code)).toBe(payload.pickupId);
	});
});

describe("gateway bootstrap hand-in", () => {
	const owner = generateIdentity();
	const phone = generateIdentity();
	const gateway = generateIdentity();
	const pickupId = bootstrapPickupId("one-time-code");
	const ask = (id = pickupId, who = gateway) => signBootstrapAsk(id, who.sign.pub, who.sign.priv);

	it("hands a held frame to the Gateway it was left for, and to nobody else", () => {
		const { service, domains } = world();
		domains.set("home", domainOf(owner, [gateway]));
		const frame = frameFrom(phone, gateway);

		expect(service.status("home", pickupId)).toEqual({ held: false });
		expect(service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, frame)).toEqual({ held: true });
		expect(service.status("home", pickupId)).toEqual({ held: true });
		expect(service.ask(ask()).frame).toEqual(frame);

		const stranger = generateIdentity();
		expect(service.ask(ask(pickupId, stranger))).toEqual({});
		// The right key named, signed by another.
		expect(service.ask({ ...ask(pickupId, stranger), gatewaySignPub: gateway.sign.pub })).toEqual({});
		expect(service.ask(ask(bootstrapPickupId("another-code")))).toEqual({});
		// Another Domain learns nothing of it.
		expect(service.status("elsewhere", pickupId)).toEqual({ held: false });
	});

	it("refuses a frame the caller did not seal, or for a Gateway its Domain does not admit", () => {
		const { service, domains } = world();
		const revoked = generateIdentity();
		domains.set("home", domainOf(owner, [gateway, revoked], [revoked]));
		const stranger = generateIdentity();

		const forged = { ...frameFrom(stranger, gateway), signerSignPub: phone.sign.pub };
		expect(service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, forged).refusal).toBe("bad_frame");
		// Sealed by someone else, handed in under their name.
		expect(
			service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, frameFrom(stranger, gateway)).refusal,
		).toBe("bad_frame");
		expect(
			service.put("home", phone.sign.pub, pickupId, stranger.sign.pub, frameFrom(phone, stranger)).refusal,
		).toBe("not_admitted");
		expect(service.put("home", phone.sign.pub, pickupId, revoked.sign.pub, frameFrom(phone, revoked)).refusal).toBe(
			"not_admitted",
		);
		expect(service.status("home", pickupId)).toEqual({ held: false });

		// Revoked after the hand-in: nothing left to collect.
		expect(service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, frameFrom(phone, gateway)).held).toBe(
			true,
		);
		domains.set("home", domainOf(owner, [gateway], [gateway]));
		expect(service.ask(ask())).toEqual({});
		expect(service.status("home", pickupId)).toEqual({ held: false });
	});

	it("bounds what one Domain can leave, and keeps another Domain off a held id", () => {
		const { service, domains } = world();
		domains.set("home", domainOf(owner, [gateway]));
		const otherOwner = generateIdentity();
		domains.set("other", domainOf(otherOwner, [gateway]));

		const big = service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, frameFrom(phone, gateway, 300_000));
		expect(big.refusal).toBe("too_large");

		expect(service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, frameFrom(phone, gateway)).held).toBe(
			true,
		);
		expect(
			service.put("other", phone.sign.pub, pickupId, gateway.sign.pub, frameFrom(phone, gateway)).refusal,
		).toBe("taken");
		// The holder may hand in again.
		const again = frameFrom(phone, gateway);
		expect(service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, again).held).toBe(true);
		expect(service.ask(ask()).frame).toEqual(again);

		// One is held already.
		const more = Array.from({ length: MAX_BOOTSTRAPS_PER_DOMAIN }, (_, index) =>
			service.put(
				"home",
				phone.sign.pub,
				bootstrapPickupId(`code-${index}`),
				gateway.sign.pub,
				frameFrom(phone, gateway),
			),
		);
		expect(more.slice(0, -1).every((result) => result.held)).toBe(true);
		expect(more.at(-1)?.refusal).toBe("too_many");
		// A full Domain does not fill the next one.
		expect(
			service.put(
				"other",
				phone.sign.pub,
				bootstrapPickupId("theirs"),
				gateway.sign.pub,
				frameFrom(phone, gateway),
			).held,
		).toBe(true);
	});

	it("lets a frame go when its Gateway registers, and when nobody collected it in time", () => {
		const { service, domains, registers, advance } = world();
		domains.set("home", domainOf(owner, [gateway]));
		const frame = frameFrom(phone, gateway);

		service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, frame);
		// Another Gateway's registration is not its own.
		registers("home", generateIdentity());
		expect(service.ask(ask()).frame).toEqual(frame);
		registers("home", gateway);
		expect(service.ask(ask())).toEqual({});

		service.put("home", phone.sign.pub, pickupId, gateway.sign.pub, frame);
		advance(29 * 60_000);
		expect(service.ask(ask()).frame).toEqual(frame);
		advance(2 * 60_000);
		expect(service.ask(ask())).toEqual({});
		expect(service.status("home", pickupId)).toEqual({ held: false });
	});
});
