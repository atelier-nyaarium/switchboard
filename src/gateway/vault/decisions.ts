// Grants are gateway-local, and each names the holder it was given to.

import { z } from "zod";
import type { Ambient } from "../../shared/ambient.js";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import {
	holderOf,
	VAULT_SESSION_GRANT_CAP_MS,
	VAULT_WINDOW_MS,
	type VaultDecision,
	type VaultGrant,
	VaultGrantSchema,
	type VaultHolder,
} from "../../shared/schemasVault.js";
import { coveredBy, shapeFrom } from "./operationSet.js";

export interface VaultDecisionsDeps {
	/** Opened through `openDurable`, so a poisoned file starts this store fresh. */
	store: DurableStore;
	ambient: Pick<Ambient, "newId">;
	sessionCapMs?: number;
	/**
	 * The routine whose occurrence is live in this session right now, verified by provenance rather
	 * than by the session's name. Absent means no standing grant covers anything.
	 */
	routineHolding?: (sessionTarget: string) => string | null;
}

/** Grant scope: entry, display shape, covered shapes, session. */
export interface GrantScope {
	entryId: string;
	displayShape: string;
	coveredShapes: string[];
	sessionTarget: string;
}

const GrantsSchema = z.array(VaultGrantSchema);

/**
 * What the owner reads: the grants tab's line, and the title a saved typed value takes. It reads
 * the words as written, so it holds for text no parser accepts. `operationSet` is what a grant
 * covers.
 */
export function displayShape(operation: string): string {
	return shapeFrom(operation.trim().split(/\s+/).filter(Boolean));
}

export function createVaultDecisions(deps: VaultDecisionsDeps) {
	const { store } = deps;
	const sessionCapMs = deps.sessionCapMs ?? VAULT_SESSION_GRANT_CAP_MS;
	let grants: VaultGrant[] = GrantsSchema.parse(store.load() ?? []);

	/** A revocation lands on disk before it is reported; the rest is best effort. */
	const commit = (next: VaultGrant[], checked: boolean): boolean => {
		const previous = grants;
		grants = next;
		if (!checked) {
			store.save(grants);
			return true;
		}
		try {
			store.saveChecked(grants);
			return true;
		} catch (error) {
			// An installed snapshot is what a reopen reads.
			if (error instanceof DurableStoreInstalledError) return true;
			grants = previous;
			console.warn(`[vault] grant write failed: ${(error as Error).message}`);
			return false;
		}
	};
	const sweep = (now: number): void => {
		const kept = grants.filter((grant) => grant.expiresAt === undefined || grant.expiresAt > now);
		if (kept.length !== grants.length) commit(kept, false);
	};

	/**
	 * Session and standing grants cover every shape; a window grant covers a request whose programs
	 * it all named. A standing grant covers only while its routine is live in the asking session.
	 */
	const covers = (scope: GrantScope, now: number): VaultGrant | undefined => {
		sweep(now);
		const live = deps.routineHolding?.(scope.sessionTarget) ?? null;
		return grants.find((grant) => {
			if (grant.entryId !== scope.entryId) return false;
			const holder = holderOf(grant);
			if (!holder) return false;
			if (holder.kind === "routine") return live !== null && holder.routineId === live;
			if (holder.sessionTarget !== scope.sessionTarget) return false;
			if (grant.tier === "session") return true;
			// Read the old name until 2026-09-19.
			const covered = grant.coveredShapes ?? grant.shapes;
			return covered !== undefined && coveredBy(scope.coveredShapes, covered);
		});
	};

	/** Once leaves no grant. */
	const grant = (decision: VaultDecision, scope: GrantScope, now: number): VaultGrant | null => {
		if (decision !== "window" && decision !== "session") return null;
		const holder: VaultHolder = { kind: "session", sessionTarget: scope.sessionTarget };
		const granted: VaultGrant =
			decision === "window"
				? {
						grantId: deps.ambient.newId(),
						tier: "window",
						entryId: scope.entryId,
						shape: scope.displayShape,
						displayShape: scope.displayShape,
						coveredShapes: scope.coveredShapes,
						holder,
						sessionTarget: scope.sessionTarget,
						expiresAt: now + VAULT_WINDOW_MS,
					}
				: {
						grantId: deps.ambient.newId(),
						tier: "session",
						entryId: scope.entryId,
						holder,
						sessionTarget: scope.sessionTarget,
						expiresAt: now + sessionCapMs,
					};
		commit([...grants, granted], false);
		return granted;
	};

	/**
	 * What a routine is authorized to reach, made to match its linked entries exactly. Only the owner
	 * reaches this, through a routine save, so nothing inside a session can widen it.
	 */
	const setRoutineGrants = (routineId: string, entryIds: string[]): VaultGrant[] => {
		const mine = (grant: VaultGrant) => {
			const holder = holderOf(grant);
			return holder?.kind === "routine" && holder.routineId === routineId;
		};
		const wanted = new Set(entryIds);
		const kept = grants.filter((grant) => !mine(grant) || (grant.entryId && wanted.has(grant.entryId)));
		const held = new Set(kept.filter(mine).map((grant) => grant.entryId));
		const added: VaultGrant[] = entryIds
			.filter((entryId) => !held.has(entryId))
			.map((entryId) => ({
				grantId: deps.ambient.newId(),
				tier: "standing" as const,
				entryId,
				holder: { kind: "routine" as const, routineId },
			}));
		if (kept.length !== grants.length || added.length > 0) commit([...kept, ...added], true);
		return grants.filter(mine);
	};

	/** Everything a routine held, when the routine itself goes. */
	const routineEnded = (routineId: string): void => {
		setRoutineGrants(routineId, []);
	};

	/** Every holder loses a grant on an entry that no longer exists. */
	const entryDeleted = (entryId: string): void => {
		const kept = grants.filter((grant) => grant.entryId !== entryId);
		if (kept.length !== grants.length) commit(kept, true);
	};

	/**
	 * What the vault actually holds, whole. A delta says which entries went, but a full list is the
	 * only thing that catches an entry that went while nobody was listening, which is what a restart
	 * and a re-provision both are.
	 */
	const entriesListed = (entryIds: string[]): void => {
		const live = new Set(entryIds);
		const kept = grants.filter((grant) => grant.entryId === undefined || live.has(grant.entryId));
		if (kept.length !== grants.length) commit(kept, true);
	};

	const list = (now: number): VaultGrant[] => {
		sweep(now);
		return [...grants];
	};

	const revoke = (grantId: string): boolean => {
		const kept = grants.filter((grant) => grant.grantId !== grantId);
		return kept.length !== grants.length && commit(kept, true);
	};

	const sessionEnded = (sessionTarget: string): void => {
		const kept = grants.filter((grant) => {
			const holder = holderOf(grant);
			return holder?.kind !== "session" || holder.sessionTarget !== sessionTarget;
		});
		if (kept.length !== grants.length) commit(kept, true);
	};

	return {
		covers,
		grant,
		list,
		revoke,
		sessionEnded,
		setRoutineGrants,
		routineEnded,
		entryDeleted,
		entriesListed,
	};
}

export type VaultDecisions = ReturnType<typeof createVaultDecisions>;
