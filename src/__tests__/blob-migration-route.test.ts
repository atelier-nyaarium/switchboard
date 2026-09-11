// Remove-by: 2026-09-25, with the blob migration route.
import { describe, expect, it, vi } from "vitest";
import { createBlobMigrationRoute, migrateRouterBlobs } from "../gateway/router/blobMigrationRoute.js";
import { BLOB_HOLD_MAX_MS } from "../shared/router-protocol.js";

type Answer = { error?: string; result?: unknown };

/** Records name held references. */
function router(references: Array<{ ref: string; blobIds: string[] }>) {
	const held = new Set<string>();
	const bound: Array<{ ref: string; blobIds: string[] }> = [];
	const holds: Array<{ blobId: string; holdId: string; ttlMs: number }> = [];
	const call = vi.fn(async (action: string, params: Record<string, unknown>): Promise<Answer> => {
		if (action === "blob_migration_inventory") return { result: { references } };
		if (action === "blob_migration_bind") {
			const missing = (params.blobIds as string[]).find((blobId) => !held.has(blobId));
			if (missing) return { result: { outcome: "refused", reason: "blob_missing", blobId: missing } };
			bound.push({ ref: params.ref as string, blobIds: params.blobIds as string[] });
			return { result: { outcome: "accepted" } };
		}
		if (action === "blob_hold") {
			holds.push(params as { blobId: string; holdId: string; ttlMs: number });
			return { result: { outcome: held.has(params.blobId as string) ? "accepted" : "refused" } };
		}
		if (action === "blob_fetch")
			return { result: { outcome: held.has(params.blobId as string) ? "fetched" : "absent" } };
		return { error: `unknown ${action}` };
	});
	return { call, held, bound, holds };
}

/** Uploads local staging. */
function gateway(local: string[], routerHeld: Set<string>) {
	const disk = new Set(local);
	const uploader = {
		stage: vi.fn(async (blobId: string) => {
			if (routerHeld.has(blobId)) return { kind: "already_held" as const };
			if (!disk.has(blobId)) return { kind: "absent" as const };
			routerHeld.add(blobId);
			return { kind: "staged" as const };
		}),
		hold: vi.fn(async (blobId: string, holdId: string, ttlMs: number) => {
			const answer = await callRef.current("blob_hold", { blobId, holdId, ttlMs });
			return (answer.result as { outcome: string }).outcome === "accepted";
		}),
	};
	const blobs = { ids: () => [...disk], remove: vi.fn((blobId: string) => disk.delete(blobId)) };
	return { uploader, blobs, disk };
}

const callRef: { current: (action: string, params: Record<string, unknown>) => Promise<Answer> } = {
	current: async () => ({}),
};

describe("blob migration route", () => {
	it("binds what the Router names, holds the rest, and retires local bytes the Router now holds", async () => {
		const r = router([
			{ ref: "entry:e1", blobIds: ["sha256-a", "sha256-b"] },
			{ ref: "row:owner:d/o:4", blobIds: ["sha256-c"] },
		]);
		callRef.current = r.call;
		const g = gateway(["sha256-a", "sha256-b", "sha256-c", "sha256-orphan", "sha256-pending"], r.held);
		const namedHere = (blobId: string) => blobId === "sha256-pending";

		const report = await migrateRouterBlobs({ blobs: g.blobs, namedHere }, { call: r.call, uploader: g.uploader });

		expect(report).toMatchObject({ outcome: "done", references: 2, bound: 2, held: 2, retired: 4, unresolved: [] });
		expect(r.bound).toEqual([
			{ ref: "entry:e1", blobIds: ["sha256-a", "sha256-b"] },
			{ ref: "row:owner:d/o:4", blobIds: ["sha256-c"] },
		]);
		expect(r.holds.map((hold) => [hold.holdId, hold.ttlMs])).toEqual([
			["sha256-orphan", BLOB_HOLD_MAX_MS],
			["sha256-pending", BLOB_HOLD_MAX_MS],
		]);
		expect([...g.disk]).toEqual(["sha256-pending"]);
	});

	it("reports a set it cannot bind and keeps those bytes on disk", async () => {
		const r = router([{ ref: "entry:e2", blobIds: ["sha256-here", "sha256-lost"] }]);
		callRef.current = r.call;
		const g = gateway(["sha256-here"], r.held);

		const report = await migrateRouterBlobs(
			{ blobs: g.blobs, namedHere: () => false },
			{ call: r.call, uploader: g.uploader },
		);

		expect(report).toMatchObject({
			outcome: "partial",
			bound: 0,
			missing: [{ ref: "entry:e2", blobIds: ["sha256-lost"] }],
			unresolved: [{ ref: "entry:e2", blobId: "sha256-lost" }],
		});
		expect(report.retired).toBe(0);
		expect(g.disk.has("sha256-here")).toBe(true);
	});

	it("runs again over what the first run left, and binds the same sets", async () => {
		const r = router([{ ref: "entry:e3", blobIds: ["sha256-x"] }]);
		callRef.current = r.call;
		const g = gateway(["sha256-x"], r.held);
		const deps = { blobs: g.blobs, namedHere: () => false };
		await migrateRouterBlobs(deps, { call: r.call, uploader: g.uploader });
		const second = await migrateRouterBlobs(deps, { call: r.call, uploader: g.uploader });

		expect(second).toMatchObject({ outcome: "done", bound: 1, retired: 0 });
		expect(r.bound).toHaveLength(2);
	});

	it("is absent without a credential and refuses the wrong one", async () => {
		const slice = { call: vi.fn(), uploader: { stage: vi.fn(), hold: vi.fn() } };
		const blobs = { ids: () => [], remove: vi.fn() };
		const absent = createBlobMigrationRoute({
			token: undefined,
			blobs,
			slice: () => slice,
			namedHere: () => false,
		});
		const armed = createBlobMigrationRoute({ token: "secret", blobs, slice: () => slice, namedHere: () => false });
		const post = (routes: Map<string, (req: Request, body: unknown) => Promise<Response>>, token?: string) =>
			routes.get("/migration/router-blobs")?.(
				new Request("http://localhost/migration/router-blobs", {
					method: "POST",
					headers: token ? { authorization: `Bearer ${token}` } : {},
				}),
				{},
			) as Promise<Response>;

		expect((await post(absent, "secret")).status).toBe(404);
		expect((await post(armed, "wrong")).status).toBe(403);
		expect((await post(armed)).status).toBe(403);
		expect(slice.call).not.toHaveBeenCalled();
		const unenrolled = createBlobMigrationRoute({
			token: "secret",
			blobs,
			slice: () => null,
			namedHere: () => false,
		});
		expect((await post(unenrolled, "secret")).status).toBe(503);
	});
});
