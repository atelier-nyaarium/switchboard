// A typed request answered from a held entry.

import { type AuthorizationPolicy, MAX_SELECTOR_LEN } from "../../shared/schemasPolicy.js";
import type {
	ConsoleVaultAnswerEntryResult,
	VaultAnswerRefusal,
	VaultEntryTier,
	VaultRemember,
} from "../../shared/schemasVault.js";
import type { PolicyStore } from "../policies/store.js";
import { rememberable } from "./decisions.js";
import { rememberedPolicy } from "./remember.js";
import type { VaultRequests } from "./requests.js";
import type { VaultUse } from "./vaultUse.js";

export interface AnswerEntryDeps {
	use: Pick<VaultUse, "ready" | "usable">;
	requests: Pick<VaultRequests, "claimTyped" | "unclaim" | "answerEntry">;
	/** Read late. */
	policies: () => Pick<PolicyStore, "get" | "put">;
}

export interface EntryAnswer {
	requestId: string;
	entryId: string;
	decision: VaultEntryTier;
	remember?: VaultRemember;
}

const refusedAnswer = (refusal: VaultAnswerRefusal): ConsoleVaultAnswerEntryResult => ({ ok: false, refusal });

export function createAnswerEntry(deps: AnswerEntryDeps) {
	/** The policy a remember writes, or the answer refusing it. */
	const remembered = (
		key: string,
		entryId: string,
		remember: VaultRemember,
	): { policy: AuthorizationPolicy } | ConsoleVaultAnswerEntryResult => {
		if (!rememberable(key)) {
			const long = key.length > MAX_SELECTOR_LEN;
			return refusedAnswer({ code: "cannot_remember", ...(long ? { max: MAX_SELECTOR_LEN } : {}) });
		}
		const store = deps.policies();
		const plan = rememberedPolicy(store.get(remember.policyId), key, entryId, remember);
		if (plan.kind === "refused") return refusedAnswer(plan.refusal);
		if (plan.kind === "policy_refused") return { ok: false, policyRefusal: plan.refusal };
		if (plan.kind === "held") return { policy: plan.policy };
		const put = store.put(plan.policy, plan.base === undefined ? {} : { base: plan.base });
		if (put.policy) return { policy: put.policy };
		return { ok: false, ...(put.refusal ? { policyRefusal: put.refusal } : {}) };
	};

	/**
	 * After `ready`, synchronous, so nothing interleaves. The claim is answered or given back, a
	 * throw included, and a refusal leaves everything as it was.
	 */
	return async ({ requestId, entryId, decision, remember }: EntryAnswer): Promise<ConsoleVaultAnswerEntryResult> => {
		const ready = await deps.use.ready();
		if (ready.kind !== "ready") return refusedAnswer({ code: "unready" });
		const request = deps.requests.claimTyped(requestId);
		if ("code" in request) return refusedAnswer(request);
		try {
			const found = deps.use.usable(ready.client, entryId);
			if (found.kind !== "usable") return refusedAnswer({ code: "unusable", unusable: found.code });
			let policy: AuthorizationPolicy | undefined;
			if (remember) {
				const written = remembered(request.displayShape, entryId, remember);
				if ("ok" in written) return written;
				policy = written.policy;
			}
			const ref = policy ? { policyId: policy.id, policyRevision: policy.revision } : undefined;
			const refusal = deps.requests.answerEntry(request, decision, entryId, ref);
			if (refusal) return refusedAnswer(refusal);
			return { ok: true, ...(policy ? { policy } : {}) };
		} finally {
			// A no-op once answered.
			deps.requests.unclaim(requestId);
		}
	};
}
