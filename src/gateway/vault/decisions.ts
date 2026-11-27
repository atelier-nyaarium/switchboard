// Grants are Gateway-local and holder-bound.

import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { basenameOf } from "../../shared/command-wrappers.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import { type AuthorizationPolicy, MAX_SELECTOR_LEN } from "../../shared/schemasPolicy.js";
import {
	type PolicyRef,
	VAULT_SESSION_GRANT_CAP_MS,
	VAULT_WINDOW_MS,
	type VaultAnswering,
	type VaultDecision,
	type VaultGrant,
	VaultGrantSchema,
	type VaultHolder,
} from "../../shared/schemasVault.js";
import { keyProgram, parseSudo, selectorKey, sudoCommand } from "../../shared/selector-key.js";
import { coveredBy } from "./operationSet.js";

export interface VaultDecisionsDeps {
	/** Poisoned stores start fresh. */
	store: DurableStore;
	ambient: Pick<Ambient, "newId">;
	sessionCapMs?: number;
	/** Provenance-verified live routine; null grants no standing access. */
	routineHolding?: (sessionTarget: string) => string | null;
}

export interface GrantScope {
	entryId: string;
	displayShape: string;
	coveredShapes: string[];
	sessionTarget: string;
	policy?: PolicyRef;
}

/** A service reads on the Gateway's own behalf, through its standing grant alone. */
export interface ServiceScope {
	entryId: string;
	serviceId: string;
}

/** Current record, read late. */
export type PolicyResolver = (policyId: string) => AuthorizationPolicy | null;

type StandingHolder = Exclude<VaultHolder, { kind: "session" }>;

const sameHolder = (a: VaultHolder, b: StandingHolder): boolean =>
	(a.kind === "routine" && b.kind === "routine" && a.routineId === b.routineId) ||
	(a.kind === "service" && b.kind === "service" && a.serviceId === b.serviceId);

const GrantsSchema = z.array(VaultGrantSchema);

// skew:vault-watcher-grants: watcher rows predate services.
const asService = (grant: VaultGrant): VaultGrant =>
	grant.holder.kind === "watcher"
		? { ...grant, holder: { kind: "service", serviceId: grant.holder.watcherId } }
		: grant;

/** Why a policy stopped answering. */
export function qualificationRefusal(
	current: AuthorizationPolicy | null,
	resolved: { entryId: string; policyRevision: number; displayShape?: string },
): string | null {
	if (!current) return "the policy is gone";
	if (!current.enabled) return "the policy is disabled";
	if (current.binding.entryId !== resolved.entryId) return "the policy binds another entry";
	if (resolved.displayShape !== undefined && !current.selectorKeys.includes(resolved.displayShape))
		return "the policy no longer names this command";
	if (current.revision !== resolved.policyRevision) return "the policy changed";
	return null;
}

/** A standing grant is entry-wide and carries none. */
const policyOf = (grant: VaultGrant): PolicyRef | undefined => (grant.tier === "standing" ? undefined : grant.policy);

/** The policy does not answer for this grant. */
function disqualified(grant: VaultGrant, current: AuthorizationPolicy | null): boolean {
	const policy = policyOf(grant);
	if (policy === undefined) return false;
	// Only a window grant names a shape.
	const resolved = {
		entryId: grant.entryId,
		policyRevision: policy.policyRevision,
		...(grant.tier === "window" ? { displayShape: grant.displayShape } : {}),
	};
	return qualificationRefusal(current, resolved) !== null;
}

/** The selector key: what the owner reads and what a policy selects on. */
export function displayShape(operation: string): string {
	return selectorKey(operation);
}

/** Blatant only; never a block. */
const RUNS_ANYTHING = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh", "su"]);

/** The key's program runs any command, or sudo's options ask for a shell. */
export function runsAnything(key: string): boolean {
	return shellWords(key.split(" "));
}

/** Sees through what the key sees through, and a nested sudo. */
function shellWords(words: readonly string[]): boolean {
	const line = parseSudo(words);
	if (!line) return words[0] !== undefined && RUNS_ANYTHING.has(basenameOf(words[0]));
	if (line.shell) return true;
	const command = sudoCommand(line);
	const head = command[0];
	if (head === undefined) return false;
	return basenameOf(head) === "sudo" ? shellWords(command) : RUNS_ANYTHING.has(basenameOf(head));
}

/** The key stored is the key shown, within the store's bound. */
export function rememberable(key: string): boolean {
	return key.length <= MAX_SELECTOR_LEN && selectorKey(key) === key;
}

/** Sudo keys share one password. */
const SHARED_PROGRAM = "sudo";

export function answeringOf(
	key: string,
	policies: readonly AuthorizationPolicy[],
	usable: (entryId: string) => boolean,
): VaultAnswering[] {
	if (keyProgram(key) !== SHARED_PROGRAM) return [];
	const byEntry = new Map<string, VaultAnswering>();
	for (const policy of policies) {
		const { entryId } = policy.binding;
		if (!policy.enabled || byEntry.has(entryId)) continue;
		if (!policy.selectorKeys.some((held) => keyProgram(held) === SHARED_PROGRAM)) continue;
		if (!usable(entryId)) continue;
		byEntry.set(entryId, { entryId, policy: { policyId: policy.id, policyRevision: policy.revision } });
	}
	return [...byEntry.values()];
}

export function createVaultDecisions(deps: VaultDecisionsDeps) {
	const { store } = deps;
	const sessionCapMs = deps.sessionCapMs ?? VAULT_SESSION_GRANT_CAP_MS;
	const loaded = GrantsSchema.parse(store.load() ?? []);
	let grants: VaultGrant[] = loaded.map(asService);
	// skew:vault-watcher-grants: rewritten once at load.
	if (loaded.some((grant) => grant.holder.kind === "watcher"))
		commitChecked(store, grants, () => {}, { label: "vault grant" });

	/** Persist revocations before reporting. */
	const commit = (next: VaultGrant[], checked: boolean): boolean => {
		if (!checked) {
			grants = next;
			store.save(next);
			return true;
		}
		return commitChecked(
			store,
			next,
			() => {
				grants = next;
			},
			{ label: "vault grant" },
		).landed;
	};
	const sweep = (now: number): void => {
		const kept = grants.filter((grant) => grant.tier === "standing" || grant.expiresAt > now);
		if (kept.length !== grants.length) commit(kept, false);
	};

	/** Sessions cover all shapes; windows cover named programs. Standing grants require their holder. */
	const covers = (scope: GrantScope | ServiceScope, now: number): VaultGrant | undefined => {
		sweep(now);
		if ("serviceId" in scope) {
			const service: StandingHolder = { kind: "service", serviceId: scope.serviceId };
			return grants.find((grant) => grant.entryId === scope.entryId && sameHolder(grant.holder, service));
		}
		const live = deps.routineHolding?.(scope.sessionTarget) ?? null;
		return grants.find((grant) => {
			if (grant.entryId !== scope.entryId) return false;
			if (grant.tier === "standing")
				return live !== null && grant.holder.kind === "routine" && grant.holder.routineId === live;
			// Policy grants are revision-scoped; windows stay shape-scoped.
			if (grant.policy !== undefined) {
				if (
					grant.policy.policyId !== scope.policy?.policyId ||
					grant.policy.policyRevision !== scope.policy.policyRevision
				)
					return false;
				if (grant.tier === "window" && grant.displayShape !== scope.displayShape) return false;
			}
			if (grant.holder.kind !== "session" || grant.holder.sessionTarget !== scope.sessionTarget) return false;
			if (grant.tier === "session") return true;
			return coveredBy(scope.coveredShapes, grant.coveredShapes);
		});
	};

	/** Once leaves no grant. */
	const grant = (decision: VaultDecision, scope: GrantScope, now: number): VaultGrant | null => {
		if (decision !== "window" && decision !== "session") return null;
		const holder: VaultHolder = { kind: "session", sessionTarget: scope.sessionTarget };
		const qualified = scope.policy ? { policy: scope.policy } : {};
		const granted: VaultGrant =
			decision === "window"
				? {
						grantId: deps.ambient.newId(),
						tier: "window",
						entryId: scope.entryId,
						displayShape: scope.displayShape,
						coveredShapes: scope.coveredShapes,
						holder,
						expiresAt: now + VAULT_WINDOW_MS,
						...qualified,
					}
				: {
						grantId: deps.ambient.newId(),
						tier: "session",
						entryId: scope.entryId,
						holder,
						expiresAt: now + sessionCapMs,
						...qualified,
					};
		commit([...grants, granted], false);
		return granted;
	};

	/** Owner ops alone set standing grant entries. */
	const setStandingGrants = (holder: StandingHolder, entryIds: string[]): VaultGrant[] => {
		const mine = (grant: VaultGrant) => sameHolder(grant.holder, holder);
		const wanted = new Set(entryIds);
		const kept = grants.filter((grant) => !mine(grant) || wanted.has(grant.entryId));
		const held = new Set(kept.filter(mine).map((grant) => grant.entryId));
		const added: VaultGrant[] = [...wanted]
			.filter((entryId) => !held.has(entryId))
			.map((entryId) => ({ grantId: deps.ambient.newId(), tier: "standing" as const, entryId, holder }));
		if (kept.length !== grants.length || added.length > 0) commit([...kept, ...added], true);
		return grants.filter(mine);
	};

	const setRoutineGrants = (routineId: string, entryIds: string[]): VaultGrant[] =>
		setStandingGrants({ kind: "routine", routineId }, entryIds);

	const setServiceGrants = (serviceId: string, entryIds: string[]): VaultGrant[] =>
		setStandingGrants({ kind: "service", serviceId }, entryIds);

	const routineEnded = (routineId: string): void => {
		setRoutineGrants(routineId, []);
	};

	const entryDeleted = (entryId: string): void => {
		const kept = grants.filter((grant) => grant.entryId !== entryId);
		if (kept.length !== grants.length) commit(kept, true);
	};

	/** Full lists reconcile entries missed while offline. */
	const entriesListed = (entryIds: string[]): void => {
		const live = new Set(entryIds);
		const kept = grants.filter((grant) => live.has(grant.entryId));
		if (kept.length !== grants.length) commit(kept, true);
	};

	/** Prune grants against the committed policy. */
	const policyMoved = (policyId: string, current: AuthorizationPolicy | null): void => {
		const kept = grants.filter((grant) => policyOf(grant)?.policyId !== policyId || !disqualified(grant, current));
		if (kept.length !== grants.length) commit(kept, true);
	};

	/** The store's whole list. */
	const policiesListed = (policyOf_: PolicyResolver): void => {
		const kept = grants.filter((grant) => {
			const policy = policyOf(grant);
			return policy === undefined || !disqualified(grant, policyOf_(policy.policyId));
		});
		if (kept.length !== grants.length) commit(kept, true);
	};

	const list = (now: number): VaultGrant[] => {
		sweep(now);
		return [...grants];
	};

	/** Standing grants never expire. */
	const standing = (): VaultGrant[] => grants.filter((grant) => grant.tier === "standing");

	const revoke = (grantId: string): boolean => {
		const kept = grants.filter((grant) => grant.grantId !== grantId);
		return kept.length !== grants.length && commit(kept, true);
	};

	const sessionEnded = (sessionTarget: string): void => {
		const kept = grants.filter(
			(grant) => grant.holder.kind !== "session" || grant.holder.sessionTarget !== sessionTarget,
		);
		if (kept.length !== grants.length) commit(kept, true);
	};

	return {
		covers,
		grant,
		list,
		standing,
		revoke,
		sessionEnded,
		setRoutineGrants,
		setServiceGrants,
		routineEnded,
		entryDeleted,
		entriesListed,
		policyMoved,
		policiesListed,
	};
}

export type VaultDecisions = ReturnType<typeof createVaultDecisions>;
