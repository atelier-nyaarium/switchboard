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
import { createReadAnchorsService, ORPHAN_ANCHOR_MS } from "../federation-server/tier1/readAnchorsService.js";

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
	const reported = new Set<string>();
	const service = createReadAnchorsService({
		registry,
		hasSession: (_domainId, gatewayId, sessionId) => reported.has(`${gatewayId}/${sessionId}`),
		pokeOwner: (id, result) => planes.push({ domainId: id, version: result.version, payload: result }),
	});
	service.register(hooks);
	return {
		registry,
		service,
		ownerOps,
		planes,
		reported,
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
			stream: "team-a",
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
		expect(held).toMatchObject({ anchors: [{ stream: "team-a", epoch: 2, seq: 17, at: 4_000 }] });
	});

	it("drops a forgotten session's anchors, and an older forget's leftovers once a day unreported", async () => {
		const harness = make();
		const report = harness.ownerOps.get("report_read");
		if (!report) throw new Error("read-anchor owner ops were not registered");
		const streams = () => harness.service.read(domainId).anchors.map((anchor) => anchor.stream);
		const mark = (stream: string) => report(operation, { kind: "report_read", stream, epoch: 1, seq: 1, at: 1 });
		for (const stream of [
			"domain.gw.host.gone",
			"scheduled:domain.gw.host.gone",
			"domain.gw.host.left",
			"domain.gw.host.live",
			"friend.gw.host.shared",
			"scheduled-results",
		])
			await mark(stream);
		harness.reported.add("gw/host.live");
		const before = harness.service.read(domainId).version.version;

		expect(harness.service.forgetSession(domainId, "domain.gw.host.gone")).toBe(true);
		expect(streams()).toEqual([
			"domain.gw.host.left",
			"domain.gw.host.live",
			"friend.gw.host.shared",
			"scheduled-results",
		]);
		expect(harness.service.read(domainId).version.version).toBe(before + 1);

		// Too fresh to judge.
		expect(harness.service.sweepOrphans(domainId, 4_000 + ORPHAN_ANCHOR_MS - 1)).toBe(0);
		expect(harness.service.sweepOrphans(domainId, 4_000 + ORPHAN_ANCHOR_MS)).toBe(1);
		// A friend's session and a stream that names none stay.
		expect(streams()).toEqual(["domain.gw.host.live", "friend.gw.host.shared", "scheduled-results"]);
	});

	it("pushes the held plane for a stale report", async () => {
		const harness = make();
		const report = harness.ownerOps.get("report_read");
		if (!report) throw new Error("report_read was not registered");
		await report(operation, { kind: "report_read", stream: "team-a", epoch: 2, seq: 17, at: 1 });
		await report(operation, { kind: "report_read", stream: "team-a", epoch: 2, seq: 16, at: 2 });

		expect(harness.planes).toHaveLength(2);
		expect(harness.planes[1]).toEqual(harness.planes[0]);
	});
});
