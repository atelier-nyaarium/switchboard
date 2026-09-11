// Remove-by: 2026-09-25, once every Gateway-held blob is bound on the Router.
import crypto from "node:crypto";
import { z } from "zod";
import type { BlobStore } from "../../shared/blob-store.js";
import { BLOB_HOLD_MAX_MS } from "../../shared/router-protocol.js";
import type { createBlobUploader } from "./blobUploader.js";

export const BLOB_MIGRATION_PATH = "/migration/router-blobs";

type Call = (action: string, params: Record<string, unknown>) => Promise<{ error?: string; result?: unknown }>;
type Handler = (req: Request, body: unknown) => Promise<Response>;

export interface BlobMigrationSlice {
	call: Call;
	uploader: Pick<ReturnType<typeof createBlobUploader>, "stage" | "hold">;
}

export interface BlobMigrationRouteDeps {
	/** Deploy credential. */
	token: string | undefined;
	blobs: Pick<BlobStore, "ids" | "remove">;
	/** Active federation slice. */
	slice: () => BlobMigrationSlice | null;
	/** Queued data names bytes. */
	namedHere: (blobId: string) => boolean;
	/** Expires deliveries before sweeping. */
	sweepDeliveries?: () => void;
}

export interface BlobMigrationReport {
	outcome: "done" | "partial";
	references: number;
	bound: number;
	missing: Array<{ ref: string; blobIds: string[] }>;
	refused: Array<{ ref: string; reason: string }>;
	held: number;
	holdFailed: Array<{ blobId: string; reason: string }>;
	retired: number;
	unresolved: Array<{ ref: string; blobId: string }>;
}

const InventorySchema = z.object({
	references: z.array(z.object({ ref: z.string().min(1), blobIds: z.array(z.string()).min(1) })),
});

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const routerHolds = (outcome: { kind: string }): boolean =>
	outcome.kind === "staged" || outcome.kind === "already_held";

async function inventory(call: Call): Promise<z.infer<typeof InventorySchema>["references"]> {
	const answer = await call("blob_migration_inventory", {});
	const parsed = answer.error ? null : InventorySchema.safeParse(answer.result);
	if (!parsed?.success) throw new Error(answer.error ?? "inventory unparsed");
	return parsed.data.references;
}

/** Binds what the Router names, holds the rest, retires what the Router now holds. */
export async function migrateRouterBlobs(
	deps: Pick<BlobMigrationRouteDeps, "blobs" | "namedHere" | "sweepDeliveries">,
	{ call, uploader }: BlobMigrationSlice,
): Promise<BlobMigrationReport> {
	deps.sweepDeliveries?.();
	const references = await inventory(call);
	const report: BlobMigrationReport = {
		outcome: "done",
		references: references.length,
		bound: 0,
		missing: [],
		refused: [],
		held: 0,
		holdFailed: [],
		retired: 0,
		unresolved: [],
	};
	const referenced = new Set(references.flatMap((set) => set.blobIds));
	const local = new Set(deps.blobs.ids());
	const routerHeld = new Set<string>();

	for (const set of references) {
		const absent: string[] = [];
		let failed: string | null = null;
		for (const blobId of new Set(set.blobIds)) {
			const staged = await uploader.stage(blobId);
			if (staged.kind === "absent") absent.push(blobId);
			else if (staged.kind === "failed") failed = staged.error;
		}
		if (failed) {
			report.refused.push({ ref: set.ref, reason: failed });
			continue;
		}
		const bound = await call("blob_migration_bind", { ref: set.ref, blobIds: set.blobIds });
		const answer = bound.error ? null : (bound.result as { outcome?: string; reason?: string; blobId?: string });
		if (answer?.outcome === "accepted") {
			report.bound++;
			for (const blobId of set.blobIds) routerHeld.add(blobId);
		} else if (answer?.reason === "blob_missing") {
			report.missing.push({
				ref: set.ref,
				blobIds: [...new Set([...absent, ...(answer.blobId ? [answer.blobId] : [])])],
			});
		} else {
			report.refused.push({
				ref: set.ref,
				reason: bound.error ?? answer?.reason ?? answer?.outcome ?? "unparsed",
			});
		}
	}

	for (const blobId of local) {
		if (referenced.has(blobId)) continue;
		const staged = await uploader.stage(blobId);
		if (!routerHolds(staged)) {
			report.holdFailed.push({ blobId, reason: staged.kind === "failed" ? staged.error : staged.kind });
			continue;
		}
		if (await uploader.hold(blobId, blobId, BLOB_HOLD_MAX_MS)) {
			report.held++;
			routerHeld.add(blobId);
		} else report.holdFailed.push({ blobId, reason: "hold refused" });
	}

	for (const blobId of routerHeld) {
		if (!local.has(blobId) || deps.namedHere(blobId)) continue;
		deps.blobs.remove(blobId);
		report.retired++;
	}

	for (const set of await inventory(call)) {
		for (const blobId of new Set(set.blobIds)) {
			const fetched = await call("blob_fetch", { blobId, range: { offset: 0, length: 1 } });
			const outcome = fetched.error ? null : (fetched.result as { outcome?: string }).outcome;
			if (outcome !== "fetched") report.unresolved.push({ ref: set.ref, blobId });
		}
	}

	const clean =
		!report.missing.length && !report.refused.length && !report.holdFailed.length && !report.unresolved.length;
	report.outcome = clean ? "done" : "partial";
	return report;
}

export function createBlobMigrationRoute(deps: BlobMigrationRouteDeps): Map<string, Handler> {
	let running = false;
	const authorized = (req: Request): boolean => {
		const presented = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
		const expected = Buffer.from(deps.token ?? "");
		return (
			expected.length > 0 && presented.length === expected.length && crypto.timingSafeEqual(presented, expected)
		);
	};
	const handler: Handler = async (req) => {
		if (!deps.token) return json({ error: "not found" }, 404);
		if (!authorized(req)) return json({ error: "unauthorized" }, 403);
		const slice = deps.slice();
		if (!slice) return json({ error: "this Gateway is not enrolled" }, 503);
		if (running) return json({ error: "a migration is already running" }, 409);
		running = true;
		try {
			return json(await migrateRouterBlobs(deps, slice), 200);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 502);
		} finally {
			running = false;
		}
	};
	return new Map([[BLOB_MIGRATION_PATH, handler]]);
}
