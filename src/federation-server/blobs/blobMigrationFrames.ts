// Remove-by: 2026-09-25, once every Gateway-held blob is bound on the Router.
import { z } from "zod";
import { parseBlobReference } from "../../shared/blob-reference.js";
import { formatInboxAddress, INBOX_ROW_TTL_MS } from "../../shared/schemasInbox.js";
import { landed } from "../../shared/write-result.js";
import type { OwnerStoreRegistry } from "../inbox/ownerStoreRegistry.js";
import { OwnerQuarantined } from "../owner/ownerStateStore.js";
import type { OwnerServiceHooks } from "../ownerServiceHooks.js";
import type { ReferenceHeldStore } from "./referenceHeldStore.js";

const BindParamsSchema = z.object({
	ref: z.string().min(1),
	blobIds: z.array(z.string()).min(1).max(64),
	incarnation: z.number().int().positive(),
});

/** Lists and binds staged blobs. */
export function registerBlobMigrationFrames(
	hooks: OwnerServiceHooks,
	deps: { registry: OwnerStoreRegistry; held: ReferenceHeldStore },
): void {
	hooks.gatewayFrame("blob_migration_inventory", "read", (reg) => {
		try {
			return { references: deps.held.inventory(reg.domainId, INBOX_ROW_TTL_MS) };
		} catch (error) {
			if (error instanceof OwnerQuarantined)
				return { ok: false, error: "refused", reason: "durability_uncertain" };
			throw error;
		}
	});
	hooks.gatewayFrame("blob_migration_bind", "value", (reg, params) => {
		const parsed = BindParamsSchema.safeParse(params);
		const ref = parsed.success ? parseBlobReference(parsed.data.ref) : null;
		if (!parsed.success || !ref) return { ok: false, error: "invalid blob_migration_bind" };
		try {
			let expiresAt: number | undefined;
			if (ref.kind === "row") {
				const store = deps.registry.for(reg.domainId);
				const row = store.rows(formatInboxAddress(ref.address), ref.seq, 1).find((item) => item.seq === ref.seq)
					?.row as { acceptedAt?: number } | undefined;
				if (!row) return { outcome: "refused", reason: "row_gone" };
				expiresAt = Number(row.acceptedAt ?? 0) + INBOX_ROW_TTL_MS;
			}
			const write = deps.held.publish(reg.domainId, [{ ref, blobIds: parsed.data.blobIds, expiresAt }], () => {});
			if (landed(write)) return { outcome: "accepted" };
			if (write.kind === "blob_missing")
				return { outcome: "refused", reason: "blob_missing", blobId: write.blobId };
			return { outcome: "refused", reason: write.kind };
		} catch (error) {
			if (error instanceof OwnerQuarantined)
				return { ok: false, error: "refused", reason: "durability_uncertain" };
			throw error;
		}
	});
}
