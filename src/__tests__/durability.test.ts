import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableOpStore } from "../gateway/console/durableOpStore.js";
import { createConsolePushOps } from "../gateway/consolePushOps.js";
import { createGatewayRelayHandler } from "../gateway/federation/gatewayRelay.js";
import { ReadAnchors } from "../gateway/readAnchors.js";
import { processAmbient } from "../shared/ambient.js";
import { DurableStore, openDurable } from "../shared/durable-store.js";
import { invalidate, MIGRATING, readGatewayMigrationWindow, useMigrationEpochFile } from "../shared/migration-fence.js";
import { PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { type JobContract, PendingJobStore } from "../shared/pending-job-store.js";
import { PlaneRegistry } from "../shared/plane-registry.js";
import { Address, storeKey } from "../shared/session-id.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("delivery-state durability", () => {
	const jobId = (conv: string, spawn: string) =>
		storeKey({ kind: "conv", conversationId: conv, address: Address.of("bob", "hostb", spawn, "dev") });
	const asked = (conv: string): JobContract => ({
		kind: "local",
		reply: { kind: "conversation", conversationId: conv },
	});
	function anchor(store: PendingJobStore<string>, id: string, contract: JobContract, persistent: boolean): void {
		const reserved = store.reserve(id, "Aqua", "host.team", contract, { persistent });
		if (reserved.kind !== "ok") throw new Error(reserved.reason);
		store.commit(reserved.reservation);
	}

	it("persistent job anchors (and their stored result) survive snapshot/restore", () => {
		const id = jobId("c1", "team");
		const transient = jobId("c2", "other");
		const a = new PendingJobStore<string>(600_000, processAmbient());
		anchor(a, id, asked("c1"), true);
		// Async delivery stores the result.
		a.settle(id, "hello");
		// Non-persistent jobs do not survive restore.
		anchor(a, transient, asked("c2"), false);

		const snap = a.snapshot();
		expect(snap.jobs.length).toBe(1);
		expect(snap.jobs[0].id).toBe(id);

		const b = new PendingJobStore<string>(600_000, processAmbient());
		expect(b.restore(snap).restored).toBe(1);
		expect(b.poll(id)).toBe("hello");
		expect(b.has(transient)).toBe(false);
	});

	it("a restore never clobbers a live entry that beat the load", () => {
		const id = jobId("x", "team");
		const a = new PendingJobStore<string>(600_000, processAmbient());
		anchor(a, id, asked("x"), true);
		a.settle(id, "old");
		const snap = a.snapshot();

		const b = new PendingJobStore<string>(600_000, processAmbient());
		anchor(b, id, asked("x"), true);
		// Live registration races restore.
		b.settle(id, "fresh");
		b.restore(snap);
		// The live entry wins restore.
		expect(b.poll(id)).toBe("fresh");
	});

	it("drops a persisted row whose contract disagrees with its session key", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const report = store.restore({
			version: 2,
			jobs: [
				{
					id: jobId("c1", "team"),
					from: "a",
					to: "b",
					contract: asked("someone-else"),
					state: "waiting",
					createdAt: 0,
					storedResult: null,
				},
			],
		});
		expect(report).toMatchObject({ restored: 0, rejected: 1 });
	});

	const legacyRow = (id: string, conversationId: string, extra: Record<string, unknown> = {}) => ({
		id,
		from: "a",
		to: "b",
		state: "waiting",
		createdAt: 0,
		storedResult: null,
		fromConversationId: conversationId,
		returnRoute: null,
		dstDomainId: null,
		...extra,
	});

	it("migrates legacy rows, telling the owner's thread from a session's by the owner id", () => {
		const routed = jobId("c1", "team");
		const ownerThread = jobId("owner-key", "team");
		const sessionThread = jobId("c3", "team");
		const store = new PendingJobStore<string>(600_000, processAmbient());

		const report = store.restore(
			[
				legacyRow(routed, "c1", {
					dstDomainId: "alice",
					returnRoute: { srcGateway: "alice-gw", srcConversationId: "c1", srcSession: routed },
				}),
				legacyRow(ownerThread, "owner-key"),
				legacyRow(sessionThread, "c3"),
			],
			"owner-key",
		);

		expect(report).toMatchObject({ restored: 3, rejected: 0, legacy: true });
		const contracts = store.snapshot().jobs.map((job) => job.contract);
		expect(contracts).toContainEqual({ kind: "local", reply: { kind: "owner", ownerId: "owner-key" } });
		expect(contracts).toContainEqual({ kind: "local", reply: { kind: "conversation", conversationId: "c3" } });
	});

	it("quarantines a legacy local row when no owner id can classify it", () => {
		const store = new PendingJobStore<string>(600_000, processAmbient());
		const id = jobId("c2", "team");
		const report = store.restore([legacyRow(id, "c2")], null);

		expect(report).toMatchObject({ restored: 0, rejected: 1, legacy: true });
		expect(store.has(id)).toBe(false);
	});
});

describe("migration fence durability", () => {
	it("refuses durable writers while fenced and accepts them after removal", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-fence-"));
		roots.push(dir);
		const ambient = processAmbient();
		const pending = openDurable(dir, "pending-deliveries", (store) => new PendingDeliveryStore(store, ambient));
		const ops = new DurableOpStore(new DurableStore(dir, "console-ops"), ambient);
		const anchors = new ReadAnchors(new PlaneRegistry(ambient), undefined);
		const push = createConsolePushOps({
			dataDir: dir,
			ownerId: () => "owner",
			localGatewayId: "gateway",
			localAddress: (() => ({ canonical: "domain.gateway.team.session" })) as never,
			refuseImpersonation: () => null,
			ambient,
		});
		const relay = createGatewayRelayHandler({
			routes: {
				acceptGatewaySend: async () => new Response("{}"),
				respond: () => new Response("{}"),
				teams: () => new Response("[]"),
				localSpawnPoints: () => [],
				landCrossDomainPresence: () => {},
			},
			tryWakeTeam: async () => ({ ok: true }),
			localGatewayId: "gateway",
			localDomainId: "domain",
		});
		const file = path.join(dir, "migration-epoch");
		fs.writeFileSync(file, "8\n");
		useMigrationEpochFile(dir);
		invalidate();

		expect(readGatewayMigrationWindow()).toEqual({ fenced: true, epoch: 8 });
		expect(
			pending.enqueue({
				deliveryId: "fenced",
				team: "team",
				channelJobId: "job",
				from: "from",
				body: "body",
				enqueuedAt: 1,
			} as never),
		).toBe("migrating");
		expect(ops.markInFlight("conversation", "fenced")).toBeNull();
		expect(anchors.report("owner", "team", { epoch: 1, seq: 1, at: 1 })).toBe(false);
		expect(push.deliverToOwner({ entry: { kind: "notice" } as never, dedupeKey: "fenced" })).toBe(MIGRATING);
		expect(await relay.handleOp({ kind: "wake", team: "team" }, "peer", null)).toEqual({
			ok: false,
			error: "migrating",
		});

		fs.rmSync(file);
		invalidate();
		expect(
			pending.enqueue({
				deliveryId: "live",
				team: "team",
				channelJobId: "job",
				from: "from",
				body: "body",
				enqueuedAt: 1,
			} as never),
		).toBe("enqueued");
		expect(ops.markInFlight("conversation", "live")).toEqual(expect.any(Number));
		expect(anchors.report("owner", "team", { epoch: 1, seq: 1, at: 1 })).toBe(true);
		expect(push.deliverToOwner({ entry: { kind: "notice" } as never, dedupeKey: "live" })).toBe(true);
		expect(await relay.handleOp({ kind: "wake", team: "team" }, "peer", null)).toEqual({ ok: true });
	});
});
