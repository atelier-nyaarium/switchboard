// The gateway names every revision it stores, and takes a put only from the one it already held.

import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import {
	type AuthorizationPolicy,
	AuthorizationPolicySchema,
	canonicalPolicy,
	MAX_POLICIES_PER_GATEWAY,
	policyRefusal,
} from "../../shared/schemasPolicy.js";
import { REVISION_CEILING } from "../../shared/schemasRunbook.js";

export interface PolicyStoreDeps {
	/** Poisoned files start fresh. */
	store: DurableStore;
	/** Called after each landed write. */
	onChanged: (policyId: string) => void;
}

export interface PolicyPutResult {
	stored: boolean;
	revision: number;
	/** Adopted by the caller. */
	policy?: AuthorizationPolicy;
	reason?: string;
}

export interface PolicyPutOptions {
	/** Revision the caller edited. */
	base?: number;
}

export interface PolicyDeleteResult {
	deleted: boolean;
	reason?: string;
}

const PoliciesSchema = z.array(AuthorizationPolicySchema);

/** Bounds the buried set. */
const MAX_BURIED = 256;

/** Held records are frozen. */
function frozen(policy: AuthorizationPolicy): AuthorizationPolicy {
	return Object.freeze({
		...policy,
		binding: Object.freeze({ ...policy.binding }),
		selectorShapes: Object.freeze([...policy.selectorShapes]) as string[],
	});
}

/** Equal but for revision. */
function sameContent(a: AuthorizationPolicy, b: AuthorizationPolicy): boolean {
	const owned = ({ revision: _revision, ...rest }: AuthorizationPolicy) => rest;
	return canonicalJson(owned(a)) === canonicalJson(owned(b));
}

/** One enabled policy per key, naming the holder; the binding is soft and never refused here. */
function contextRefusal(candidate: AuthorizationPolicy, others: AuthorizationPolicy[]): string | null {
	const rest = others.filter((other) => other.id !== candidate.id);
	if (rest.length >= MAX_POLICIES_PER_GATEWAY) {
		return `this Gateway holds ${MAX_POLICIES_PER_GATEWAY} policies already`;
	}
	if (!candidate.enabled) return null;
	for (const other of rest) {
		if (!other.enabled) continue;
		const taken = candidate.selectorShapes.find((key) => other.selectorShapes.includes(key));
		if (taken !== undefined) return `${taken} is already answered by ${other.name}`;
	}
	return null;
}

/** Only what a put could write. */
function restoreRefusal(policies: AuthorizationPolicy[]): string | null {
	if (policies.length > MAX_POLICIES_PER_GATEWAY) return `${policies.length} policies stored`;
	const ids = new Set<string>();
	for (const policy of policies) {
		if (ids.has(policy.id)) return `${policy.id} is stored twice`;
		ids.add(policy.id);
		const refusal = policyRefusal(policy) ?? contextRefusal(policy, policies);
		if (refusal) return `${policy.id}: ${refusal}`;
	}
	return null;
}

export function createPolicyStore(deps: PolicyStoreDeps) {
	const { store } = deps;
	const restored = PoliciesSchema.parse(store.load() ?? []).map(frozen);
	const poisoned = restoreRefusal(restored);
	if (poisoned) throw new Error(poisoned);
	let policies: AuthorizationPolicy[] = restored;

	/** What a deleted id last held, so a delayed put cannot land it back. Not durable. */
	const buried = new Map<string, number>();

	/** On disk before reported. */
	const commit = (next: AuthorizationPolicy[], policyId: string): boolean => {
		const previous = policies;
		policies = next;
		try {
			store.saveChecked(policies);
			deps.onChanged(policyId);
			return true;
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) {
				deps.onChanged(policyId);
				return true;
			}
			policies = previous;
			console.warn(`[policy] write failed: ${(error as Error).message}`);
			return false;
		}
	};

	const held = (id: string): AuthorizationPolicy | undefined => policies.find((policy) => policy.id === id);

	const list = (): AuthorizationPolicy[] =>
		[...policies].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

	const get = (id: string): AuthorizationPolicy | null => held(id) ?? null;

	/** The one enabled policy that answers a key, unique by construction. */
	const byKey = (key: string): AuthorizationPolicy | null =>
		policies.find((policy) => policy.enabled && policy.selectorShapes.includes(key)) ?? null;

	const put = (incoming: AuthorizationPolicy, options: PolicyPutOptions = {}): PolicyPutResult => {
		const current = held(incoming.id);
		const held0 = current?.revision ?? 0;
		// Canonical before comparison.
		const candidate = frozen(canonicalPolicy(incoming));
		const refusal = policyRefusal(candidate) ?? contextRefusal(candidate, policies);
		if (refusal) return { stored: false, revision: held0, reason: refusal };
		if (current) {
			// A repeat is a lost answer.
			const echoesFirst = options.base === undefined && current.revision === 1;
			const echoesEdit = options.base === current.revision || options.base === current.revision - 1;
			if ((echoesFirst || echoesEdit) && sameContent(candidate, current)) {
				return { stored: true, revision: current.revision, policy: current };
			}
			if (options.base !== current.revision) {
				return {
					stored: false,
					revision: current.revision,
					reason: `revision ${current.revision} is stored; this edits ${options.base ?? "nothing"}`,
				};
			}
		}
		if (!current && options.base !== undefined) {
			return { stored: false, revision: 0, reason: "no policy with that id is stored" };
		}
		const grave = buried.get(incoming.id);
		if (!current && grave !== undefined) {
			return { stored: false, revision: 0, reason: `revision ${grave} was deleted; save it as a new policy` };
		}
		if (held0 >= REVISION_CEILING) {
			return { stored: false, revision: held0, reason: "this policy has no revision left to write" };
		}
		const policy = frozen({ ...candidate, revision: held0 + 1 });
		const next = current
			? policies.map((existing) => (existing.id === policy.id ? policy : existing))
			: [...policies, policy];
		if (!commit(next, policy.id)) return { stored: false, revision: held0, reason: "could not be written" };
		return { stored: true, revision: policy.revision, policy };
	};

	/** A whole-record write at the revision the phone read, so a stale toggle is refused like a put. */
	const setEnabled = (id: string, enabled: boolean, base: number): PolicyPutResult => {
		const current = held(id);
		if (!current) return { stored: false, revision: 0, reason: "no policy with that id is stored" };
		if (base !== current.revision) {
			return {
				stored: false,
				revision: current.revision,
				reason: `revision ${current.revision} is stored; this edits ${base}`,
			};
		}
		if (current.enabled === enabled) return { stored: true, revision: current.revision, policy: current };
		return put({ ...current, enabled }, { base: current.revision });
	};

	const remove = (id: string, base: number): PolicyDeleteResult => {
		const going = held(id);
		if (!going) return { deleted: false, reason: "no policy with that id is stored" };
		if (base !== going.revision) {
			return { deleted: false, reason: `revision ${going.revision} is stored; this deletes ${base}` };
		}
		const deleted = commit(
			policies.filter((policy) => policy.id !== id),
			id,
		);
		if (!deleted) return { deleted: false, reason: "could not be written" };
		buried.set(id, going.revision);
		// Oldest out.
		for (const stale of [...buried.keys()].slice(0, Math.max(0, buried.size - MAX_BURIED))) {
			buried.delete(stale);
		}
		return { deleted: true };
	};

	return { list, get, byKey, put, setEnabled, remove };
}

export type PolicyStore = ReturnType<typeof createPolicyStore>;
