import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayFrameHandler, GatewayRegistration } from "../federation-server/gatewayBridge.js";
import { OwnerStoreRegistry } from "../federation-server/inbox/ownerStoreRegistry.js";
import { DomainQuota } from "../federation-server/owner/domainQuota.js";
import { OwnerQuarantined } from "../federation-server/owner/ownerStateStore.js";
import type {
	ErasedOwnerOpHandler,
	OwnerOpHandler,
	OwnerOpKind,
	OwnerOpMutation,
} from "../federation-server/ownerOpRegistry.js";
import { createPresenceService } from "../federation-server/presence/presenceService.js";
import { TeamInfoSchema } from "../shared/schemasPresence.js";

const roots: string[] = [];
const row = (team: string, lastActive = 1, status: "online" | "verifying" | "available" = "online") =>
	TeamInfoSchema.parse({
		team,
		gatewayId: "gw",
		domainId: "domain",
		status,
		kind: "devcontainer",
		queue_depth: 1,
		lastActive,
	});
const make = (pokeOwner?: (domainId: string, version: number, projection: unknown) => void) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-presence-"));
	roots.push(dataDir);
	const registry = new OwnerStoreRegistry({
		dataDir,
		ownerOf: () => "owner",
		quotaFor: () =>
			new DomainQuota({
				dir: dataDir,
				limitBytes: 10_000_000,
				reserveBytes: 0,
				statfs: () => ({ available: 10_000_000 }),
			}),
		ambient: { now: () => 100 },
	});
	return {
		registry,
		service: createPresenceService({ registry, pokeOwner, ...(pokeOwner ? { projection: projectionDeps } : {}) }),
	};
};
const reg: GatewayRegistration = { domainId: "domain", gatewayId: "gw", signPub: "pub", incarnation: 1 };
const names = new Map<string, string | null>([["domain", "Alice"]]);
const projectionDeps = {
	admittedGateways: () => ["gw"],
	linkedDomains: () => [],
	isShared: () => false,
	connected: () => ["gw"],
	displayName: (domainId: string) => names.get(domainId) ?? null,
	isAdminDomain: (domainId: string) => domainId === "domain",
};

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("router presence slice", () => {
	it("returns uncertainty from the presence read frame", () => {
		const { registry } = make();
		const service = createPresenceService({ registry, projection: projectionDeps });
		const frames = new Map<string, GatewayFrameHandler>();
		const classes = new Map<string, string>();
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (name, mutation, handler) => {
				classes.set(name, mutation);
				frames.set(name, handler);
			},
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: () => false,
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
			onSweep: () => undefined,
		});
		expect([...classes]).toEqual([
			["presence_baseline", "delivery"],
			["presence_delta", "delivery"],
			["presence_read", "read"],
		]);
		const store = registry.for("domain");
		vi.spyOn(store, "get").mockImplementation(() => {
			throw new OwnerQuarantined({ from: 1, to: 1 });
		});
		expect(frames.get("presence_read")!(reg, {})).toEqual({ outcome: "durability_uncertain" });
		registry.close();
	});

	it("answers resync through the dispatched frame to a baseline the schema refuses", () => {
		const { registry } = make();
		const service = createPresenceService({ registry, projection: projectionDeps });
		const frames = new Map<string, GatewayFrameHandler>();
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (name, _mutation, handler) => frames.set(name, handler),
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: () => false,
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
			onSweep: () => undefined,
		});
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		const oldRow = { team: "proj.main", gatewayId: "gw", status: "online", kind: "loose", queue_depth: 0 };
		const oldSpawns = { gatewayId: "gw", hostSpawns: [] };
		expect(
			frames.get("presence_baseline")!(reg, { incarnation: 1, seq: 0, rows: [oldRow], spawnPoints: oldSpawns }),
		).toEqual({ resync: true });
		// Parked rows are inactive.
		const served = frames.get("presence_read")!(reg, {}) as {
			rows: Array<{ team: string; presenceFresh: string }>;
		};
		expect(served.rows.map((r) => [r.team, r.presenceFresh])).toEqual([["proj.main", "unreachable"]]);
		registry.close();
	});

	it("refreshes the Domains linked to the one that changed, and skips a Domain it does not hold", () => {
		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-presence-"));
		roots.push(dataDir);
		const held = new Set(["domain", "friend"]);
		const registry = new OwnerStoreRegistry({
			dataDir,
			ownerOf: (domainId) => (held.has(domainId) ? "owner" : null),
			quotaFor: () =>
				new DomainQuota({
					dir: dataDir,
					limitBytes: 10_000_000,
					reserveBytes: 0,
					statfs: () => ({ available: 10_000_000 }),
				}),
			ambient: { now: () => 100 },
		});
		const pokes: string[] = [];
		const service = createPresenceService({
			registry,
			pokeOwner: (domainId) => pokes.push(domainId),
			// Reverse edge not required.
			projection: { ...projectionDeps, linkedDomains: (domainId) => (domainId === "friend" ? ["domain"] : []) },
		});
		registry.for("friend");
		service.refresh("domain");
		expect(pokes).toEqual(["domain", "friend"]);
		expect(() => service.refresh("gone")).not.toThrow();
		expect(pokes).toEqual(["domain", "friend"]);
		registry.close();
	});
	it("applies ordered deltas and bumps the persisted projection version", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		const before = service.ownerProjection("domain", projectionDeps).plane;
		service.applyDelta(reg, { incarnation: 1, seq: 1, upserts: [row("proj.main", 2)], tombstones: [] });
		expect(service.ownerProjection("domain", projectionDeps).plane.version).toBe(before.version);
		service.applyDelta(reg, {
			incarnation: 1,
			seq: 2,
			upserts: [row("proj.main", 2, "available")],
			tombstones: [],
		});
		expect(service.ownerProjection("domain", projectionDeps).plane.version).toBe(before.version + 1);
		registry.close();
	});

	it("pushes the whole projection to the owner only when it actually changed", () => {
		const pokes: Array<{ domainId: string; version: number; teams: number }> = [];
		const { registry, service } = make((domainId, version, projection) =>
			pokes.push({ domainId, version, teams: ((projection as { rows: unknown[] }).rows ?? []).length }),
		);
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});

		service.ownerProjection("domain", projectionDeps);
		expect(pokes).toEqual([{ domainId: "domain", version: 1, teams: 1 }]);
		service.ownerProjection("domain", projectionDeps);
		expect(pokes).toHaveLength(1);

		service.applyDelta(reg, {
			incarnation: 1,
			seq: 1,
			upserts: [row("proj.main", 2, "available")],
			tombstones: [],
		});
		service.ownerProjection("domain", projectionDeps);
		expect(pokes).toEqual([
			{ domainId: "domain", version: 1, teams: 1 },
			{ domainId: "domain", version: 2, teams: 1 },
		]);
		registry.close();
	});
	it("returns an unapplied plane outcome without advancing or poking", () => {
		const pokes: unknown[] = [];
		const { registry, service } = make((...args) => pokes.push(args));
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		const store = registry.for("domain");
		vi.spyOn(store, "put").mockReturnValue({ kind: "durability_failure", reason: "full" });
		const result = service.ownerProjection("domain", { ...projectionDeps, connected: () => [] });
		expect(result).toEqual({ outcome: "durability_failure" });
		expect(store.get("presence.row", "presence.plane")).toBeNull();
		expect(pokes).toEqual([]);
		registry.close();
	});

	it("resyncs gaps and foreign incarnations without changing rows", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		expect(
			service.applyDelta(reg, { incarnation: 1, seq: 3, upserts: [row("other.main")], tombstones: [] }),
		).toEqual({ resync: true });
		expect(
			service.applyDelta(reg, { incarnation: 2, seq: 1, upserts: [row("other.main")], tombstones: [] }),
		).toEqual({ resync: true });
		expect(service.ownerProjection("domain", projectionDeps).rows.map((r) => r.team)).toEqual(["proj.main"]);
		registry.close();
	});

	it("keeps dropped rows as unreachable and replaces them on a new baseline", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main"), row("other.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		service.onGatewayDropped(reg);
		expect(registry.for("domain").get("presence.row", "presence.row:gw/proj.main")?.clear.presenceFresh).toBe(
			"unreachable",
		);
		expect(registry.for("domain").get("presence.row", "presence.row:gw/other.main")?.clear.presenceFresh).toBe(
			"unreachable",
		);
		expect(service.ownerProjection("domain", projectionDeps).spawnPoints).toEqual([
			{ gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		]);
		service.applyBaseline(
			{ ...reg, incarnation: 2 },
			{
				incarnation: 2,
				seq: 0,
				rows: [row("new.main")],
				spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: ["shell"] },
			},
		);
		expect(registry.for("domain").get("presence.row", "presence.row:gw/proj.main")).toBeNull();
		registry.close();
	});

	it("resyncs a delta after re-registration until a new baseline", () => {
		const { registry, service } = make();
		const frames = new Map<string, GatewayFrameHandler>();
		const registered: ((registration: GatewayRegistration) => void)[] = [];
		const pushed: Record<string, unknown>[] = [];
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (name, _mutation, handler) => frames.set(name, handler),
			onGatewayRegistered: (listener) => registered.push(listener),
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: (_domainId, _gatewayId, frame) => {
				pushed.push(frame);
				return true;
			},
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
			onSweep: () => undefined,
		});
		frames.get("presence_baseline")!(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		registered[0](reg);

		expect(frames.get("presence_delta")!(reg, { incarnation: 1, seq: 1, upserts: [], tombstones: [] })).toEqual({
			resync: true,
		});
		expect(pushed).toEqual([{ type: "presence_resync", incarnation: 1 }]);
		registry.close();
	});

	it("stamps the registration identity on payload rows and spawn points", () => {
		const { registry, service } = make();
		const registration = { ...reg, gatewayId: "sender", domainId: "owned" };
		service.applyBaseline(registration, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "payload", domainId: "payload", hostSpawns: ["shell"] },
		});
		const projection = service.ownerProjection("owned", {
			...projectionDeps,
			admittedGateways: () => ["sender"],
		});

		expect(projection.rows).toMatchObject([{ team: "proj.main", gatewayId: "sender", domainId: "owned" }]);
		expect(projection.spawnPoints).toEqual([{ gatewayId: "sender", domainId: "owned", hostSpawns: ["shell"] }]);
		registry.close();
	});

	it("rearms every row as unreachable", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		service.rearm("domain");

		expect(service.ownerProjection("domain", projectionDeps).rows).toMatchObject([
			{ team: "proj.main", presenceFresh: "unreachable" },
		]);
		registry.close();
	});

	it("forgets a session through the registered hook", () => {
		const { registry, service } = make();
		let forget: ((registration: GatewayRegistration, sessionId: string) => void) | undefined;
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: () => undefined,
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: (listener) => {
				forget = listener;
			},
			pushFrameTo: () => true,
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
			onSweep: () => undefined,
		});
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		forget?.(reg, "proj.main");

		expect(service.ownerProjection("domain", projectionDeps).rows).toEqual([]);
		registry.close();
	});

	it("touches live rows and not available rows", () => {
		const { registry } = make();
		const touched: string[] = [];
		const service = createPresenceService({ registry, touch: (_domainId, target) => touched.push(target) });
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("online.main"), row("available.main", 1, "available")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});

		expect(touched).toEqual(["domain.gw.online.main"]);
		registry.close();
	});

	it("keeps a gateway named gateway isolated from other gateway records", () => {
		const { registry, service } = make();
		const gateway = { ...reg, gatewayId: "gateway" };
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("gw.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: ["gw-shell"] },
		});
		service.applyBaseline(gateway, {
			incarnation: 1,
			seq: 0,
			rows: [row("gateway.main")],
			spawnPoints: { gatewayId: "gateway", domainId: "domain", hostSpawns: ["gateway-shell"] },
		});
		service.applyBaseline(
			{ ...reg, incarnation: 2 },
			{
				incarnation: 2,
				seq: 0,
				rows: [row("gw.new")],
				spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: ["gw-new-shell"] },
			},
		);

		expect(
			service.ownerProjection("domain", { ...projectionDeps, admittedGateways: () => ["gw", "gateway"] }),
		).toMatchObject({
			rows: [{ team: "gateway.main" }, { team: "gw.new" }],
			spawnPoints: [{ gatewayId: "gw" }, { gatewayId: "gateway" }],
		});
		registry.close();
	});

	it("filters friend presence and derives roster coverage", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		const projection = service.friendProjection("domain", "friend", {
			isShared: (_d, target) => target.includes("proj.main"),
		});
		expect(Object.keys(projection.sessions[0])).toEqual([
			"team",
			"gatewayId",
			"status",
			"kind",
			"sessionLabel",
			"description",
			"lastActive",
			"queueDepth",
			"working",
			"needsLogin",
		]);
		expect(service.roster("domain", ["gw", "offline"], ["gw"]).coverage).toMatchObject({
			rosterKnown: true,
			asked: 2,
			answered: 1,
			unreachable: ["offline"],
		});
		registry.close();
	});

	// Push from writes.
	it("pushes to the owner when a gateway frame changes presence", () => {
		const pokes: number[] = [];
		const { registry, service } = make((_domainId, version) => pokes.push(version));
		const frames = new Map<string, GatewayFrameHandler>();
		service.register({
			ownerOp: () => undefined,
			gatewayFrame: (name: string, _mutation: OwnerOpMutation, handler: GatewayFrameHandler) =>
				frames.set(name, handler),
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: () => true,
			gatewayIncarnation: () => 1,
			connectedGateways: () => ["gw"],
			onSweep: () => undefined,
		});

		expect(
			frames.get("presence_baseline")!(reg, {
				incarnation: 1,
				seq: 0,
				rows: [row("proj.main")],
				spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
			}),
		).toMatchObject({ ok: true });

		expect(pokes).toEqual([1]);
		// The gateway's protocol streams only after an `ok`; without it every frame is a retried baseline.
		expect(
			frames.get("presence_delta")!(reg, { incarnation: 1, seq: 1, upserts: [row("proj.main")], tombstones: [] }),
		).toMatchObject({ ok: true });
		expect(pokes).toEqual([1]);
		frames.get("presence_delta")!(reg, {
			incarnation: 1,
			seq: 2,
			upserts: [row("proj.main", 2, "available")],
			tombstones: [],
		});
		expect(pokes).toEqual([1, 2]);
		registry.close();
	});

	it("routes gateway frames and pushes resync for a gap", () => {
		const { registry, service } = make();
		const frames = new Map<string, GatewayFrameHandler>();
		const pushed: Record<string, unknown>[] = [];
		const hooks = {
			ownerOp: () => undefined,
			gatewayFrame: (name: string, _mutation: OwnerOpMutation, handler: GatewayFrameHandler) =>
				frames.set(name, handler),
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: (_domainId: string, _gatewayId: string, frame: Record<string, unknown>) => {
				pushed.push(frame);
				return true;
			},
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
			onSweep: () => undefined,
		};
		service.register(hooks);
		frames.get("presence_baseline")!(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		frames.get("presence_delta")!(reg, { incarnation: 1, seq: 2, upserts: [], tombstones: [] });
		expect(pushed).toEqual([{ type: "presence_resync", incarnation: 1 }]);
		registry.close();
	});

	it("answers linked friend reads, refuses unlinked reads, and isolates Domains", () => {
		const { registry } = make();
		const service = createPresenceService({
			registry,
			projection: {
				admittedGateways: (domainId) => (domainId === "a" ? ["gw"] : []),
				linkedDomains: (domainId) => (domainId === "a" ? ["b"] : []),
				isShared: (domainId, target, toDomainId) =>
					domainId === "b" && target.includes("b.main") && toDomainId === "a",
				connected: (domainId) => (domainId === "a" ? ["gw"] : []),
				displayName: () => null,
				isAdminDomain: () => false,
			},
			friend: { isShared: (_domainId, target, toDomainId) => target.includes("b.main") && toDomainId === "a" },
		});
		service.applyBaseline(
			{ ...reg, domainId: "a" },
			{
				incarnation: 1,
				seq: 0,
				rows: [row("a.main")],
				spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
			},
		);
		service.applyBaseline(
			{ ...reg, domainId: "b" },
			{
				incarnation: 1,
				seq: 0,
				rows: [row("b.main"), row("b.private")],
				spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
			},
		);
		const handlers = new Map<string, ErasedOwnerOpHandler>();
		service.register({
			ownerOp: <Kind extends OwnerOpKind>(kind: Kind, handler: OwnerOpHandler<Kind>) => {
				handlers.set(kind, handler as ErasedOwnerOpHandler);
			},
			gatewayFrame: () => undefined,
			onGatewayRegistered: () => undefined,
			onGatewayDropped: () => undefined,
			onSessionForgotten: () => undefined,
			pushFrameTo: () => true,
			gatewayIncarnation: () => 1,
			connectedGateways: () => [],
			onSweep: () => undefined,
		});
		const op = { domainId: "a" } as Parameters<ErasedOwnerOpHandler>[0];
		expect(handlers.get("presence_read_friend")!(op, { toDomainId: "c" })).toEqual({
			outcome: "refused",
			reason: "not linked",
		});
		expect(handlers.get("presence_read_friend")!(op, { toDomainId: "b" })).toMatchObject({
			sessions: [{ team: "b.main" }],
		});
		expect(handlers.get("presence_read_friend")!(op, { toDomainId: "b" })).not.toMatchObject({
			sessions: [{ team: "b.private" }],
		});
		expect(service.ownerProjection("a", projectionDeps).rows.map((r) => r.team)).toEqual(["a.main"]);
		registry.close();
	});
});

describe("what the Router states about the owner", () => {
	it("carries the owner's facts on the projection, and a rename pushes a new plane", () => {
		const pokes: Array<{ version: number; displayName: string | null }> = [];
		const { registry, service } = make((_domainId, version, projection) =>
			pokes.push({
				version,
				displayName: (projection as { owner: { displayName: string | null } }).owner.displayName,
			}),
		);
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		service.refresh("domain");
		expect(pokes).toEqual([{ version: 1, displayName: "Alice" }]);
		expect(service.ownerProjection("domain", projectionDeps).owner).toEqual({
			domainId: "domain",
			displayName: "Alice",
			isAdminDomain: true,
		});

		names.set("domain", "Alicia");
		service.refresh("domain");
		expect(pokes.at(-1)).toEqual({ version: 2, displayName: "Alicia" });
		service.refresh("domain");
		expect(pokes).toHaveLength(2);
		names.set("domain", "Alice");
		registry.close();
	});

	it("parks a gateway whose baseline or delta the schema refuses, and serves nothing for it", () => {
		const { registry, service } = make();
		const oldRow = { team: "proj.main", gatewayId: "gw", status: "online", kind: "loose", queue_depth: 0 };
		expect(
			service.applyBaseline(reg, {
				incarnation: 1,
				seq: 0,
				rows: [oldRow] as never,
				spawnPoints: { gatewayId: "gw", hostSpawns: [] } as never,
			}),
		).toEqual({ resync: true });
		expect(service.ownerProjection("domain", projectionDeps).rows).toEqual([]);
		expect(service.applyDelta(reg, { incarnation: 1, seq: 1, upserts: [oldRow] as never, tombstones: [] })).toEqual(
			{
				resync: true,
			},
		);
		registry.close();
	});

	it("labels a linked friend Domain with its own name", () => {
		const { registry, service } = make();
		names.set("friend", "Bob");
		service.applyBaseline(
			{ ...reg, domainId: "friend", gatewayId: "fgw" },
			{
				incarnation: 1,
				seq: 0,
				rows: [row("lib.main")],
				spawnPoints: { gatewayId: "fgw", domainId: "friend", hostSpawns: [] },
			},
		);
		const projection = service.ownerProjection("domain", {
			...projectionDeps,
			linkedDomains: () => ["friend"],
			isShared: () => true,
		});
		expect(projection.linked).toMatchObject([{ domainId: "friend", displayName: "Bob" }]);
		names.delete("friend");
		registry.close();
	});

	it("drops a stored row that fails the schema rather than serving it", () => {
		const { registry, service } = make();
		service.applyBaseline(reg, {
			incarnation: 1,
			seq: 0,
			rows: [row("proj.main")],
			spawnPoints: { gatewayId: "gw", domainId: "domain", hostSpawns: [] },
		});
		registry.for("domain").put("presence.row", "presence.row:gw/bad.main", null, {
			clear: {
				team: "bad.main",
				gatewayId: "",
				domainId: "domain",
				status: "online",
				kind: "loose",
				queue_depth: 0,
			},
		});
		const kept = {
			...row("kept.main"),
			presenceFresh: "quiet",
			working: true,
			needsLogin: false,
			limitBlocked: true,
			limitDetail: "resets 5pm",
		};
		registry.for("domain").put("presence.row", "presence.row:gw/kept.main", null, { clear: kept });
		const served = service.ownerProjection("domain", projectionDeps).rows;
		expect(served.map((r) => r.team)).toEqual(["kept.main", "proj.main"]);
		expect(served[0]).toEqual(kept);
		registry.close();
	});

	it("refuses a row that names no Gateway or no Domain", () => {
		expect(TeamInfoSchema.safeParse({ ...row("x.main"), gatewayId: "" }).success).toBe(false);
		expect(TeamInfoSchema.safeParse({ ...row("x.main"), domainId: "" }).success).toBe(false);
		const { domainId: _domainId, ...withoutDomain } = row("x.main");
		expect(TeamInfoSchema.safeParse(withoutDomain).success).toBe(false);
	});
});
