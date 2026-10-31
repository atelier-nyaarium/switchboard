import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayFrameHandler } from "../federation-server/gatewayBridge.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import type {
	ErasedOwnerOpHandler,
	OwnerOpHandler,
	OwnerOpKind,
	OwnerOpMutation,
} from "../federation-server/ownerOpRegistry.js";
import type { OwnerServiceHooks } from "../federation-server/ownerServiceHooks.js";
import { createPhoneHoldService } from "../federation-server/phone/phoneHoldService.js";
import { PHONE_HOLD_WINDOW_MS } from "../shared/schemasPhoneHold.js";

const domainId = "domain";
const roots: string[] = [];
const registries: OwnerStoreRegistry[] = [];

function makeRegistry(dataDir: string, now: () => number): OwnerStoreRegistry {
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (id) => (id === domainId || id === "friend" ? `owner-${id}` : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now },
	});
	registries.push(registry);
	return registry;
}

function make() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-phone-hold-"));
	roots.push(dataDir);
	let now = 1_000;
	const registry = makeRegistry(dataDir, () => now);
	const ownerOps = new Map<string, ErasedOwnerOpHandler>();
	const gatewayFrames = new Map<string, GatewayFrameHandler>();
	const sweepers: Array<(domainId: string, now: number) => void> = [];
	const frames: Record<string, unknown>[] = [];
	const planePushes: Array<{ domainId: string; version: number; payload: unknown }> = [];
	const hooks = {
		ownerOp: <Kind extends OwnerOpKind>(name: Kind, handler: OwnerOpHandler<Kind>) => {
			ownerOps.set(name, handler as ErasedOwnerOpHandler);
		},
		gatewayFrame: (name: string, _mutation: OwnerOpMutation, handler: GatewayFrameHandler) => {
			gatewayFrames.set(name, handler);
		},
		onGatewayRegistered: () => {},
		onGatewayDropped: () => {},
		onSessionForgotten: () => {},
		onSweep: (_label: string, sweep: (domainId: string, now: number) => void) => sweepers.push(sweep),
		pushFrameTo: (_domainId: string, _gatewayId: string, frame: Record<string, unknown>) => {
			frames.push(frame);
			return true;
		},
		gatewayIncarnation: () => 4,
		connectedGateways: () => ["gateway-a", "gateway-b"],
	} satisfies OwnerServiceHooks;
	const service = createPhoneHoldService({
		registry,
		pokeOwner: (id, version, payload) => planePushes.push({ domainId: id, version, payload }),
	});
	service.register(hooks);
	return {
		dataDir,
		registry,
		service,
		ownerOps,
		gatewayFrames,
		sweepers,
		frames,
		planePushes,
		setNow: (value: number) => (now = value),
		now: () => now,
	};
}

const operation = (signer: string) =>
	({
		domainId,
		signerSignPub: signer,
		device: "Pixel",
		conversationId: "phone",
	}) as Parameters<ErasedOwnerOpHandler>[0];

async function call(
	harness: ReturnType<typeof make>,
	kind: string,
	op: Parameters<ErasedOwnerOpHandler>[0],
	value: unknown,
) {
	const handler = harness.ownerOps.get(kind);
	if (!handler) throw new Error(`${kind} was not registered`);
	return handler(op, value as Record<string, unknown>);
}

afterEach(() => {
	for (const registry of registries.splice(0)) registry.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Router phone hold", () => {
	it("claims for the signed device and serves the held plane", async () => {
		const harness = make();
		const claim = await call(harness, "hold_claim", operation("phone-a"), { kind: "hold_claim" });
		const read = await call(harness, "phone_hold_read", operation("phone-b"), { kind: "phone_hold_read" });
		const frameRead = harness.gatewayFrames.get("phone_hold_read");
		if (!frameRead) throw new Error("phone_hold_read frame was not registered");
		const gatewayRead = await frameRead(
			{ domainId, gatewayId: "gateway-a", signPub: "gateway-key", incarnation: 4 },
			{ kind: "phone_hold_read" },
		);

		expect(claim).toEqual({ hold: { holder: "phone-a", label: "Pixel", claimedAt: 1_000, version: 1 } });
		expect(read).toEqual({ hold: { holder: "phone-a", label: "Pixel", claimedAt: 1_000, version: 1 } });
		expect(gatewayRead).toEqual(read);
		expect(harness.frames).toEqual([
			{
				type: "phone_hold",
				incarnation: 4,
				hold: { holder: "phone-a", label: "Pixel", claimedAt: 1_000, version: 1 },
			},
			{
				type: "phone_hold",
				incarnation: 4,
				hold: { holder: "phone-a", label: "Pixel", claimedAt: 1_000, version: 1 },
			},
		]);
		expect(harness.planePushes).toEqual([
			{
				domainId,
				version: 1,
				payload: { hold: { holder: "phone-a", label: "Pixel", claimedAt: 1_000, version: 1 } },
			},
		]);
		expect(harness.service.read("friend", harness.now())).toBeNull();
	});

	it("replaces a claim and lapses it at the Router window", async () => {
		const harness = make();
		await call(harness, "hold_claim", operation("phone-a"), { kind: "hold_claim" });
		harness.setNow(2_000);
		await call(harness, "hold_claim", operation("phone-b"), { kind: "hold_claim" });
		expect(harness.service.read(domainId, 2_000)).toEqual({
			holder: "phone-b",
			label: "Pixel",
			claimedAt: 2_000,
			version: 2,
		});
		expect(harness.service.read(domainId, 2_000 + PHONE_HOLD_WINDOW_MS)).toBeNull();
	});

	it("serves a lapsed holder in the plane until the sweep clears it", async () => {
		const harness = make();
		await call(harness, "hold_claim", operation("phone-a"), { kind: "hold_claim" });
		harness.setNow(1_000 + PHONE_HOLD_WINDOW_MS);

		expect(harness.service.read(domainId, harness.now())).toBeNull();
		expect(harness.service.plane(domainId)).toEqual({
			hold: { holder: "phone-a", label: "Pixel", claimedAt: 1_000, version: 1 },
		});
		harness.sweepers[0]?.(domainId, harness.now());
		expect(harness.service.plane(domainId)).toEqual({ hold: null });
	});

	it("clears a lapsed claim durably and pushes its next version", async () => {
		const harness = make();
		await call(harness, "hold_claim", operation("phone-a"), { kind: "hold_claim" });
		harness.setNow(1_000 + PHONE_HOLD_WINDOW_MS);
		const sweep = harness.sweepers[0];
		if (!sweep) throw new Error("phone hold sweep was not registered");
		sweep(domainId, harness.now());

		expect(harness.planePushes.at(-1)).toEqual({ domainId, version: 2, payload: { hold: null } });
		expect(harness.frames.slice(-2)).toEqual([
			{ type: "phone_hold", incarnation: 4, hold: null },
			{ type: "phone_hold", incarnation: 4, hold: null },
		]);
		harness.registry.close();
		const reopened = makeRegistry(harness.dataDir, harness.now);
		const restored = createPhoneHoldService({ registry: reopened });
		// Cleared, not expired.
		expect(restored.read(domainId, 1_500)).toBeNull();
	});
});
