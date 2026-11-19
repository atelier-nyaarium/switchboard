// The gateway names every revision it stores, and takes a put only from the one it already held.

import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { capFifo } from "../../shared/cap-fifo.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import {
	type AuthorizationPolicy,
	AuthorizationPolicySchema,
	canonicalPolicy,
	examplesRefusal,
	MAX_POLICIES_PER_GATEWAY,
	type PolicyRefusal,
	policyRefusal,
	refusalReason,
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
	refusal?: PolicyRefusal;
}

export interface PolicyPutOptions {
	/** Revision the caller edited. */
	base?: number;
}

export interface PolicyDeleteResult {
	deleted: boolean;
	reason?: string;
	refusal?: PolicyRefusal;
}

const putRefused = (revision: number, refusal: PolicyRefusal): PolicyPutResult => ({
	stored: false,
	revision,
	reason: refusalReason(refusal),
	refusal,
});

const deleteRefused = (refusal: PolicyRefusal): PolicyDeleteResult => ({
	deleted: false,
	reason: refusalReason(refusal),
	refusal,
});

const PoliciesSchema = z.array(AuthorizationPolicySchema);

/** Bounds the buried set. */
const MAX_BURIED = 256;

/** Held records are frozen. */
function frozen(policy: AuthorizationPolicy): AuthorizationPolicy {
	return Object.freeze({
		...policy,
		binding: Object.freeze({ ...policy.binding }),
		selectorKeys: Object.freeze([...policy.selectorKeys]) as string[],
	});
}

/** Equal but for revision. */
function sameContent(a: AuthorizationPolicy, b: AuthorizationPolicy): boolean {
	const owned = ({ revision: _revision, ...rest }: AuthorizationPolicy) => rest;
	return canonicalJson(owned(a)) === canonicalJson(owned(b));
}

/** One enabled policy per key, naming the holder; the binding is soft and never refused here. */
function contextRefusal(candidate: AuthorizationPolicy, others: AuthorizationPolicy[]): PolicyRefusal | null {
	const rest = others.filter((other) => other.id !== candidate.id);
	if (rest.length >= MAX_POLICIES_PER_GATEWAY) return { code: "full", max: MAX_POLICIES_PER_GATEWAY };
	if (!candidate.enabled) return null;
	for (const other of rest) {
		if (!other.enabled) continue;
		const taken = candidate.selectorKeys.find((key) => other.selectorKeys.includes(key));
		if (taken !== undefined) return { code: "taken", key: taken, policy: other.name };
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
		const context = contextRefusal(policy, policies);
		const refusal = policyRefusal(policy) ?? (context ? refusalReason(context) : null);
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
	const commit = (next: AuthorizationPolicy[], policyId: string): boolean =>
		commitChecked(
			store,
			next,
			(landed) => {
				policies = landed;
			},
			{ label: "policy", onLanded: () => deps.onChanged(policyId) },
		).landed;

	const held = (id: string): AuthorizationPolicy | undefined => policies.find((policy) => policy.id === id);

	const list = (): AuthorizationPolicy[] =>
		[...policies].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

	const get = (id: string): AuthorizationPolicy | null => held(id) ?? null;

	/** The one enabled policy that answers a key, unique by construction. */
	const byKey = (key: string): AuthorizationPolicy | null =>
		policies.find((policy) => policy.enabled && policy.selectorKeys.includes(key)) ?? null;

	const put = (incoming: AuthorizationPolicy, options: PolicyPutOptions = {}): PolicyPutResult => {
		const current = held(incoming.id);
		const held0 = current?.revision ?? 0;
		// Examples vanish when canonical.
		const typed = examplesRefusal(incoming.selectorKeys);
		if (typed) return putRefused(held0, typed);
		// Canonical before comparison.
		const candidate = frozen(canonicalPolicy(incoming));
		// Same shape restore reads.
		if (policyRefusal(candidate) !== null) return putRefused(held0, { code: "no_command" });
		const context = contextRefusal(candidate, policies);
		if (context) return putRefused(held0, context);
		if (current) {
			// A repeat is a lost answer.
			const echoesFirst = options.base === undefined && current.revision === 1;
			const echoesEdit = options.base === current.revision || options.base === current.revision - 1;
			if ((echoesFirst || echoesEdit) && sameContent(candidate, current)) {
				return { stored: true, revision: current.revision, policy: current };
			}
			if (options.base !== current.revision) return putRefused(current.revision, { code: "moved" });
		}
		if (!current && options.base !== undefined) return putRefused(0, { code: "gone" });
		if (!current && buried.has(incoming.id)) return putRefused(0, { code: "deleted" });
		if (held0 >= REVISION_CEILING) return putRefused(held0, { code: "spent" });
		const policy = frozen({ ...candidate, revision: held0 + 1 });
		const next = current
			? policies.map((existing) => (existing.id === policy.id ? policy : existing))
			: [...policies, policy];
		if (!commit(next, policy.id)) return putRefused(held0, { code: "unwritten" });
		return { stored: true, revision: policy.revision, policy };
	};

	/** A whole-record write at the revision the phone read, so a stale toggle is refused like a put. */
	const setEnabled = (id: string, enabled: boolean, base: number): PolicyPutResult => {
		const current = held(id);
		if (!current) return putRefused(0, { code: "gone" });
		if (base !== current.revision) return putRefused(current.revision, { code: "moved" });
		if (current.enabled === enabled) return { stored: true, revision: current.revision, policy: current };
		return put({ ...current, enabled }, { base: current.revision });
	};

	const remove = (id: string, base: number): PolicyDeleteResult => {
		const going = held(id);
		if (!going) return deleteRefused({ code: "gone" });
		if (base !== going.revision) return deleteRefused({ code: "moved" });
		const deleted = commit(
			policies.filter((policy) => policy.id !== id),
			id,
		);
		if (!deleted) return deleteRefused({ code: "unwritten" });
		buried.set(id, going.revision);
		capFifo(buried, MAX_BURIED);
		return { deleted: true };
	};

	return { list, get, byKey, put, setEnabled, remove };
}

export type PolicyStore = ReturnType<typeof createPolicyStore>;
