import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import type {
	ErasedOwnerOpHandler,
	OwnerOpHandler,
	OwnerOpKind,
	OwnerOpMutation,
} from "../federation-server/ownerOpRegistry.js";
import type { OwnerServiceHooks } from "../federation-server/ownerServiceHooks.js";
import { createReadAnchorsService } from "../federation-server/tier1/readAnchorsService.js";

const domainId = "domain";
const roots: string[] = [];
const registries: OwnerStoreRegistry[] = [];

function make() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-read-anchors-plane-"));
	roots.push(dataDir);
	let now = 4_000;
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: (id) => (id === domainId ? "owner-key" : null),
		quotaFor: () =>
			new DomainQuota({ dir: dataDir, limitBytes: 100_000_000, statfs: () => ({ available: 100_000_000 }) }),
		ambient: { now: () => now },
	});
	registries.push(registry);
	const ownerOps = new Map<string, ErasedOwnerOpHandler>();
	const planes: Array<{ domainId: string; version: { epoch: number; version: number }; payload: unknown }> = [];
	const hooks = {
		ownerOp: <Kind extends OwnerOpKind>(name: Kind, handler: OwnerOpHandler<Kind>) => {
			ownerOps.set(name, handler as ErasedOwnerOpHandler);
		},
		gatewayFrame: (_name: string, _mutation: OwnerOpMutation) => {},
		onGatewayRegistered: () => {},
		onGatewayDropped: () => {},
		onSessionForgotten: () => {},
		onSweep: () => {},
		pushFrameTo: () => true,
		gatewayIncarnation: () => null,
		connectedGateways: () => [],
	} satisfies OwnerServiceHooks;
	const service = createReadAnchorsService({
		registry,
		pokeOwner: (id, result) => planes.push({ domainId: id, version: result.version, payload: result }),
	});
	service.register(hooks);
	return {
		registry,
		service,
		ownerOps,
		planes,
		setNow: (value: number) => (now = value),
	};
}

const operation = { domainId, conversationId: "phone" } as Parameters<ErasedOwnerOpHandler>[0];

afterEach(() => {
	for (const registry of registries.splice(0)) registry.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Router read-anchor plane", () => {
	it("pushes the merged anchor after a report", async () => {
		const harness = make();
		const report = harness.ownerOps.get("report_read");
		const read = harness.ownerOps.get("read_anchors_read");
		if (!report || !read) throw new Error("read-anchor owner ops were not registered");

		const answer = await report(operation, {
			kind: "report_read",
			team: "team-a",
			epoch: 2,
			seq: 17,
			at: 1,
		});
		harness.setNow(5_000);
		const held = await read(operation, { kind: "read_anchors_read" });

		expect(answer).toMatchObject({ advanced: true });
		expect(harness.planes).toHaveLength(1);
		expect(harness.planes[0]).toEqual({
			domainId,
			version: (held as { version: { epoch: number; version: number } }).version,
			payload: held,
		});
		expect(held).toMatchObject({ anchors: [{ team: "team-a", epoch: 2, seq: 17, at: 4_000 }] });
	});

	it("pushes the held plane for a stale report", async () => {
		const harness = make();
		const report = harness.ownerOps.get("report_read");
		if (!report) throw new Error("report_read was not registered");
		await report(operation, { kind: "report_read", team: "team-a", epoch: 2, seq: 17, at: 1 });
		await report(operation, { kind: "report_read", team: "team-a", epoch: 2, seq: 16, at: 2 });

		expect(harness.planes).toHaveLength(2);
		expect(harness.planes[1]).toEqual(harness.planes[0]);
	});
});
