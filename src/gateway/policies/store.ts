// The gateway names every revision it stores, and takes a put only from the one it already held.

import { z } from "zod";
import { canonicalJson } from "../../shared/canonical-json.js";
import { capFifo } from "../../shared/cap-fifo.js";
import { type Decoded, type DurableStore, type RestoreRepairs, restoreHeld } from "../../shared/durable-store.js";
import {
	type AuthorizationPolicy,
	AuthorizationPolicySchema,
	canonicalPolicy,
	examplesRefusal,
	MAX_POLICIES_PER_GATEWAY,
	MAX_SELECTOR_LEN,
	MAX_SELECTORS_PER_POLICY,
	type PolicyRefusal,
	policyRefusal,
	refusalReason,
} from "../../shared/schemasPolicy.js";
import { REVISION_CEILING } from "../../shared/schemasRunbook.js";
import { selectorKey } from "../../shared/selector-key.js";

export interface PolicyStoreDeps {
	/** Poisoned files start fresh. */
	store: Pick<DurableStore, "load" | "saveChecked">;
	/** Called after each landed write. */
	onChanged: (policyId: string) => void;
	/** Retries a restore's rewrite. */
	repairs: RestoreRepairs;
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

/** Keys of any length. */
const StoredPoliciesSchema = z.array(
	AuthorizationPolicySchema.extend({
		selectorKeys: z.array(z.string().min(1)).min(1).max(MAX_SELECTORS_PER_POLICY),
	}),
);

/**
 * A key that is not its own `selectorKey`, or is over the bound, is dropped, never re-keyed:
 * re-keying could select lines the owner never approved. A policy left with none is dropped.
 */
function heldKeys(stored: AuthorizationPolicy[]): Decoded<AuthorizationPolicy[]> {
	let stale = false;
	const held: AuthorizationPolicy[] = [];
	for (const policy of stored) {
		const keys = policy.selectorKeys.filter((key) => key.length <= MAX_SELECTOR_LEN && selectorKey(key) === key);
		if (keys.length < policy.selectorKeys.length) {
			stale = true;
			const gone = policy.selectorKeys.length - keys.length;
			console.warn(
				`[policy] restore dropped ${gone} key(s) from ${policy.id}${keys.length ? "" : " and the policy"}`,
			);
		}
		if (keys.length === 0) continue;
		// Pruned: the next revision.
		const revision =
			keys.length < policy.selectorKeys.length
				? Math.min(policy.revision + 1, REVISION_CEILING)
				: policy.revision;
		held.push(frozen({ ...policy, selectorKeys: keys, revision }));
	}
	return { value: held, stale };
}

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

/** Restore parses every record, so a put refuses what would not parse. */
function shapeRefusal(candidate: AuthorizationPolicy): PolicyRefusal | null {
	if (AuthorizationPolicySchema.safeParse({ ...candidate, revision: 1 }).success) return null;
	if (candidate.selectorKeys.length > MAX_SELECTORS_PER_POLICY)
		return { code: "too_many_commands", max: MAX_SELECTORS_PER_POLICY };
	if (candidate.selectorKeys.some((key) => key.length > MAX_SELECTOR_LEN))
		return { code: "command_too_long", max: MAX_SELECTOR_LEN };
	return { code: "invalid" };
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
	const stored = restoreHeld({
		store: deps.store,
		label: "policy",
		repairs: deps.repairs,
		decode: (raw) => {
			const restored = heldKeys(StoredPoliciesSchema.parse(raw ?? []));
			const poisoned = restoreRefusal(restored.value);
			if (poisoned) throw new Error(poisoned);
			return restored;
		},
	});

	/** What a deleted id last held, so a delayed put cannot land it back. Not durable. */
	const buried = new Map<string, number>();

	/** On disk before reported. */
	const commit = (next: AuthorizationPolicy[], policyId: string): boolean =>
		stored.commit(next, { onLanded: () => deps.onChanged(policyId) }).landed;

	const held = (id: string): AuthorizationPolicy | undefined => stored.value.find((policy) => policy.id === id);

	const list = (): AuthorizationPolicy[] =>
		[...stored.value].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

	const get = (id: string): AuthorizationPolicy | null => held(id) ?? null;

	/** The one enabled policy that answers a key, unique by construction. */
	const byKey = (key: string): AuthorizationPolicy | null =>
		stored.value.find((policy) => policy.enabled && policy.selectorKeys.includes(key)) ?? null;

	const put = (incoming: AuthorizationPolicy, options: PolicyPutOptions = {}): PolicyPutResult => {
		const current = held(incoming.id);
		const held0 = current?.revision ?? 0;
		// Examples vanish when canonical.
		const typed = examplesRefusal(incoming.selectorKeys);
		if (typed) return putRefused(held0, typed);
		// Canonical before comparison.
		const candidate = frozen(canonicalPolicy(incoming));
		if (policyRefusal(candidate) !== null) return putRefused(held0, { code: "no_command" });
		const shape = shapeRefusal(candidate);
		if (shape) return putRefused(held0, shape);
		const context = contextRefusal(candidate, stored.value);
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
			? stored.value.map((existing) => (existing.id === policy.id ? policy : existing))
			: [...stored.value, policy];
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
			stored.value.filter((policy) => policy.id !== id),
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
