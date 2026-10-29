import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssistantHomeService } from "../federation-server/assistant/assistantHomeService.js";
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
import {
	ASSISTANT_HOME_SEALED_MAX_BYTES,
	type AssistantHomePutResult,
	type AssistantHomePutValue,
	type AssistantHomeReadResult,
} from "../shared/schemasAssistantHome.js";
import type { ContentEnvelope } from "../shared/schemasContentKey.js";

const domainId = "domain";
const roots: string[] = [];
const registries: OwnerStoreRegistry[] = [];
const operation = { domainId, conversationId: "phone" } as Parameters<ErasedOwnerOpHandler>[0];

const envelope = (bytes = 32): ContentEnvelope => ({
	v: 1,
	epoch: 1,
	nonce: Buffer.alloc(12, 1).toString("base64"),
	ciphertext: Buffer.alloc(bytes, 2).toString("base64"),
});

const putValue = (baseVersion: number, gatewayId: string | null, sealed = gatewayId ? envelope() : null) =>
	({ kind: "assistant_home_put", baseVersion, gatewayId, sealed }) satisfies AssistantHomePutValue;

const make = () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-home-service-"));
	roots.push(dataDir);
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (id) => (id === domainId ? "owner-key" : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => 1_000 },
	});
	registries.push(registry);
	const ownerOps = new Map<string, ErasedOwnerOpHandler>();
	const gatewayFrames = new Map<string, GatewayFrameHandler>();
	const pushes: { domainId: string; gatewayId: string; frame: Record<string, unknown> }[] = [];
	const pokes: number[] = [];
	let connected: string[] = [];
	const current = new Map<string, number>();
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
		onSweep: () => undefined,
		pushFrameTo: (id: string, gatewayId: string, frame: Record<string, unknown>) => {
			pushes.push({ domainId: id, gatewayId, frame });
			return true;
		},
		gatewayIncarnation: (_id: string, gatewayId: string) => current.get(gatewayId) ?? 1,
		connectedGateways: () => connected,
	} satisfies OwnerServiceHooks;
	const service = createAssistantHomeService({
		registry,
		routable: (id, gatewayId) => id === domainId && ["gateway-a", "gateway-b"].includes(gatewayId),
		pokeOwner: (_id, version) => pokes.push(version),
	});
	service.register(hooks);
	return {
		service,
		ownerOps,
		gatewayFrames,
		pushes,
		pokes,
		setConnected: (ids: string[]) => (connected = ids),
		reconnect: (gatewayId: string, incarnation: number) => current.set(gatewayId, incarnation),
	};
};

const callPut = async (harness: ReturnType<typeof make>, value: AssistantHomePutValue) => {
	const handler = harness.ownerOps.get("assistant_home_put");
	if (!handler) throw new Error("assistant_home_put was not registered");
	return (await handler(operation, value as unknown as Record<string, unknown>)) as AssistantHomePutResult;
};

const callRead = async (harness: ReturnType<typeof make>) => {
	const handler = harness.ownerOps.get("assistant_home_read");
	if (!handler) throw new Error("assistant_home_read was not registered");
	return (await handler(operation, { kind: "assistant_home_read" })) as AssistantHomeReadResult;
};

const callReport = async (
	harness: ReturnType<typeof make>,
	gatewayId: string,
	params: Record<string, unknown>,
	incarnation = 1,
) => {
	const handler = harness.gatewayFrames.get("assistant_home_report");
	if (!handler) throw new Error("assistant_home_report was not registered");
	return (await handler({ domainId, gatewayId, signPub: "gateway-key", incarnation }, params)) as {
		accepted: boolean;
	};
};

afterEach(() => {
	for (const registry of registries.splice(0)) registry.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("assistant home service", () => {
	it("applies the first put at base version zero", async () => {
		const harness = make();
		const sealed = envelope();

		expect(await callPut(harness, putValue(0, "gateway-a", sealed))).toEqual({
			outcome: "applied",
			record: { version: 1, gatewayId: "gateway-a", sealed },
		});
		expect(await callRead(harness)).toEqual({
			record: { version: 1, gatewayId: "gateway-a", sealed },
			report: null,
		});
	});

	it("returns the held record for a stale base", async () => {
		const harness = make();
		await callPut(harness, putValue(0, "gateway-a"));

		expect(await callPut(harness, putValue(0, "gateway-b"))).toEqual({
			outcome: "conflict",
			record: { version: 1, gatewayId: "gateway-a", sealed: envelope() },
		});
	});

	it("refuses oversized or unroutable choices without writing", async () => {
		const harness = make();
		const oversized = {
			...envelope(),
			ciphertext: Buffer.alloc(ASSISTANT_HOME_SEALED_MAX_BYTES + 1).toString("base64"),
		};

		expect(await callPut(harness, putValue(0, "gateway-a", oversized))).toMatchObject({
			outcome: "refused",
			refusal: "too_large",
		});
		expect(await callPut(harness, putValue(0, "offline"))).toMatchObject({
			outcome: "refused",
			refusal: "unroutable",
		});
		expect(await callRead(harness)).toEqual({ record: null, report: null });
		expect(harness.service.planeVersion(domainId)).toBe(0);
		expect(harness.pushes).toEqual([]);
		expect(harness.pokes).toEqual([]);
	});

	it("keeps a nobody choice available to later reads", async () => {
		const harness = make();
		expect(await callPut(harness, putValue(0, null))).toEqual({
			outcome: "applied",
			record: { version: 1, gatewayId: null, sealed: null },
		});
		expect(await callRead(harness)).toEqual({
			record: { version: 1, gatewayId: null, sealed: null },
			report: null,
		});
		const readFrame = harness.gatewayFrames.get("assistant_home_read");
		if (!readFrame) throw new Error("assistant_home_read frame was not registered");
		expect(
			await readFrame({ domainId, gatewayId: "gateway-a", signPub: "gateway-key", incarnation: 1 }, {}),
		).toEqual({
			record: { version: 1, gatewayId: null, sealed: null },
		});
	});

	it("announces each applied choice to every connected gateway", async () => {
		const harness = make();
		harness.setConnected(["gateway-a", "gateway-b"]);
		const sealed = envelope();
		const { record } = await callPut(harness, putValue(0, "gateway-a", sealed));

		expect(harness.pushes).toEqual([
			{ domainId, gatewayId: "gateway-a", frame: { type: "assistant_home", record } },
			{ domainId, gatewayId: "gateway-b", frame: { type: "assistant_home", record } },
		]);
	});

	it("fences reports by gateway and choice version", async () => {
		const harness = make();
		await callPut(harness, putValue(0, "gateway-a"));

		expect(await callReport(harness, "gateway-b", { version: 1, outcome: "placed" })).toEqual({ accepted: false });
		expect(await callReport(harness, "gateway-a", { version: 2, outcome: "placed" })).toEqual({ accepted: false });
		expect(await callRead(harness)).toMatchObject({ report: null });
		expect(harness.service.planeVersion(domainId)).toBe(1);
	});

	it("keeps the first report for a version and accepts its resend", async () => {
		const harness = make();
		await callPut(harness, putValue(0, "gateway-a"));

		expect(await callReport(harness, "gateway-a", { version: 1, outcome: "refused" })).toEqual({
			accepted: true,
		});
		expect(await callReport(harness, "gateway-a", { version: 1, outcome: "placed" })).toEqual({ accepted: true });
		expect(await callRead(harness)).toMatchObject({
			report: { version: 1, gatewayId: "gateway-a", outcome: "refused" },
		});
	});

	it("takes no report from a superseded connection of the named Gateway", async () => {
		const harness = make();
		await callPut(harness, putValue(0, "gateway-a"));
		harness.reconnect("gateway-a", 2);

		const stale = await callReport(harness, "gateway-a", { version: 1, outcome: "refused" }, 1);
		const current = await callReport(harness, "gateway-a", { version: 1, outcome: "placed" }, 2);

		expect([stale, current]).toEqual([{ accepted: false }, { accepted: true }]);
		expect(await callRead(harness)).toMatchObject({ report: { outcome: "placed" } });
	});

	it("shows a report only beside the choice it answers", async () => {
		const harness = make();
		await callPut(harness, putValue(0, "gateway-a"));
		await callReport(harness, "gateway-a", { version: 1, outcome: "placed" });
		expect(await callRead(harness)).toMatchObject({ report: { version: 1, gatewayId: "gateway-a" } });

		await callPut(harness, putValue(1, "gateway-b"));
		expect(await callRead(harness)).toMatchObject({
			record: { version: 2, gatewayId: "gateway-b" },
			report: null,
		});
	});

	it("pokes the owner's plane forward on each stored write, and only then", async () => {
		const harness = make();
		await callPut(harness, putValue(0, "gateway-a"));
		await callReport(harness, "gateway-a", { version: 1, outcome: "placed" });
		await callReport(harness, "gateway-a", { version: 1, outcome: "refused" });
		await callPut(harness, putValue(1, "gateway-b"));
		await callReport(harness, "gateway-a", { version: 1, outcome: "refused" });
		await callReport(harness, "gateway-b", { version: 2, outcome: "placed" });

		expect(harness.pokes).toEqual([1, 2, 3, 4]);
	});
});
