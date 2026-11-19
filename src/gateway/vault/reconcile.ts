// Every open request read against the committed policies.

import type { PolicyRef, VaultApprovedDecision } from "../../shared/schemasVault.js";
import { fireAndForget } from "../fireAndForget.js";
import type { PolicyStore } from "../policies/store.js";
import type { VaultClient } from "../router/vaultClient.js";
import type { GrantScope } from "./decisions.js";
import type { EntryRequest, EntryVerdict, VaultRequests } from "./requests.js";
import type { VaultUse } from "./vaultUse.js";

export interface VaultReconcileDeps {
	requests: Pick<VaultRequests, "reviseEntries" | "typedWaiting" | "takeOver">;
	/** Read late. */
	policies: () => Pick<PolicyStore, "get" | "byKey">;
	use: Pick<VaultUse, "ready" | "usable">;
	/** The vault copy held now, without a read. */
	heldClient: () => VaultClient | null;
	covers: (scope: GrantScope) => VaultApprovedDecision | null;
}

export function createVaultReconcile(deps: VaultReconcileDeps) {
	const { requests } = deps;
	let stopped = false;
	let typedPass: Promise<void> | null = null;
	let passAgain = false;

	/** Refused only on a reading; no vault copy says nothing, and the release reads it again. */
	const entryVerdict = (request: EntryRequest, ref: PolicyRef): EntryVerdict => {
		const policy = deps.policies().get(ref.policyId);
		if (policy?.revision === ref.policyRevision) return "keep";
		const selects =
			policy?.enabled &&
			policy.binding.entryId === request.entryId &&
			policy.selectorKeys.includes(request.displayShape);
		if (!selects) return "refuse";
		const client = deps.heldClient();
		if (client && deps.use.usable(client, request.entryId).kind !== "usable") return "refuse";
		return { revision: policy.revision };
	};

	/** A key some enabled policy names, its entry not known unusable. */
	const typedSelectable = (): boolean => {
		const client = deps.heldClient();
		return requests.typedWaiting().some((request) => {
			const policy = deps.policies().byKey(request.displayShape);
			if (!policy) return false;
			return !client || deps.use.usable(client, policy.binding.entryId).kind === "usable";
		});
	};

	/** Set while this module's own read runs, so its landing triggers nothing. */
	let reading = false;

	const takeOverTyped = async (): Promise<void> => {
		reading = true;
		const ready = await deps.use.ready().finally(() => {
			reading = false;
		});
		if (ready.kind !== "ready" || stopped) return;
		for (const request of requests.typedWaiting()) {
			const policy = deps.policies().byKey(request.displayShape);
			if (!policy || deps.use.usable(ready.client, policy.binding.entryId).kind !== "usable") continue;
			const ref = { policyId: policy.id, policyRevision: policy.revision };
			requests.takeOver(request.requestId, policy.binding.entryId, ref, deps.covers);
		}
	};

	/**
	 * Entry pass runs at once, so no tap reads a stale revision. Typed pass reads the vault one at a time.
	 */
	const reconcile = (): void => {
		if (stopped) return;
		requests.reviseEntries(entryVerdict);
		if (!typedSelectable()) return;
		if (typedPass) {
			passAgain = true;
			return;
		}
		const run = async (): Promise<void> => {
			do {
				passAgain = false;
				await takeOverTyped();
			} while (passAgain && !stopped);
		};
		typedPass = run().finally(() => {
			typedPass = null;
		});
		fireAndForget("vault reconcile", typedPass);
	};

	return {
		reconcile,
		/** A vault read landed elsewhere: an entry may have become usable. */
		landed: (): void => {
			if (!reading) reconcile();
		},
		/** Close: a pass in flight takes nothing over. */
		stop: () => {
			stopped = true;
		},
		/** The pass in flight, for a test to wait on. */
		settled: (): Promise<void> => typedPass ?? Promise.resolve(),
	};
}

export type VaultReconcile = ReturnType<typeof createVaultReconcile>;
