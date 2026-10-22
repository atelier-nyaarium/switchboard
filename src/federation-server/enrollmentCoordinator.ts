import {
	type DomainSnapshot,
	REGISTER_MAX_SKEW_MS,
	resolveAdmitted,
	type SignedAdmission,
	type SignedRevocation,
	verifyAdmission,
	verifyRevocation,
	verifySelfRevocation,
} from "../shared/admission.js";
import type { Ambient } from "../shared/ambient.js";
import { fingerprint, type Identity } from "../shared/crypto.js";
import {
	type EnrollOp,
	type EnrollOwnerPayload,
	type EnrollResult,
	type SignedXDomainLinkEdge,
	type SignedXDomainLinkRevocation,
	verifyXDomainLinkEdge,
	verifyXDomainLinkRevocation,
} from "../shared/federation-lifecycle.js";
import { WIRE_NONCE_BYTES } from "../shared/wire-vocabulary.js";
import type { WriteOutcome } from "../shared/write-result.js";
import { PostRenameSyncError } from "../shared/write-result.js";
import { DELETE_SLICE, type DomainMutation } from "./casMutation.js";
import type { EnrollmentState, EnrollmentStore } from "./federationSecret.js";
import type { TenantAdmin } from "./tenantAdmin.js";

export type DomainStatus = "rooted" | "pending" | "unrooted";

export interface DomainMeta {
	status: DomainStatus;
	displayName: string | null;
}

export function sanitizeDomainId(raw: string | undefined | null): string {
	const slug = (raw ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) throw new Error("domain id is empty after sanitizing");
	return slug;
}

const DEFAULT_NONCE_TTL_MS = 600_000;

function emptyEnrollmentState(): EnrollmentState {
	return { ownerSignPub: null, ownerBoxPub: null, admissions: [], revocations: [] };
}

export class EnrollmentCoordinator {
	private state: EnrollmentState;
	private readonly nonces = new Map<string, number>();
	private readonly nonceCleanups = new Map<string, () => void>();
	private readonly pendingRevocations = new Map<string, SignedRevocation>();
	private readonly pendingEdgeRemovals = new Set<string>();
	private rewriteRequired = false;

	public constructor(
		private readonly identity: Identity,
		private readonly store: EnrollmentStore,
		private readonly domainId: string,
		private readonly ambient: Pick<Ambient, "now" | "randomBytes">,
		private readonly nonceTtlMs: number = DEFAULT_NONCE_TTL_MS,
	) {
		this.state = structuredClone(store.load() ?? emptyEnrollmentState());
	}

	public refresh(): void {
		const state = this.store.load();
		if (state) this.state = structuredClone(state);
	}

	private async transition<T>(mutator: (current: EnrollmentState) => DomainMutation<T>): Promise<T> {
		let published: EnrollmentState | null = null;
		let decided = false;
		try {
			const value = await this.store.mutateDomain((current) => {
				const base = structuredClone(current ?? emptyEnrollmentState());
				const draft = structuredClone(base);
				let decision = mutator(draft);
				if (!decision.commit && this.rewriteRequired)
					decision = { commit: true, next: base, value: decision.value };
				decided = true;
				published = decision.commit
					? decision.next === DELETE_SLICE
						? null
						: structuredClone(decision.next)
					: base;
				return decision;
			});
			if (decided) this.state = published ?? emptyEnrollmentState();
			this.rewriteRequired = false;
			return value;
		} catch (error) {
			if (error instanceof PostRenameSyncError) this.rewriteRequired = true;
			throw error;
		}
	}

	private edgeKey(srcDomainId: string, dstDomainId: string): string {
		return JSON.stringify([srcDomainId, dstDomainId]);
	}

	private stageRevocation(signed: SignedRevocation): void {
		this.pendingRevocations.set(this.revocationKey(signed), signed);
	}

	private clearRevocation(signed: SignedRevocation): void {
		this.pendingRevocations.delete(this.revocationKey(signed));
	}

	private revocationKey(signed: SignedRevocation): string {
		return JSON.stringify([
			signed.revocation.signPub,
			signed.revocation.issuedAt,
			signed.revocation.nonce,
			signed.ownerSignPub,
			signed.signature,
		]);
	}

	private hasLinkEdgeIn(state: EnrollmentState, srcDomainId: string, dstDomainId: string): boolean {
		if (!state.ownerSignPub) return false;
		let newest: number | null = null;
		for (const edge of state.linkEdges ?? []) {
			if (edge.edge.srcDomainId !== srcDomainId || edge.edge.dstDomainId !== dstDomainId) continue;
			if (!verifyXDomainLinkEdge(edge, state.ownerSignPub)) continue;
			if (newest === null || edge.edge.issuedAt > newest) newest = edge.edge.issuedAt;
		}
		if (newest === null) return false;
		for (const revocation of state.linkRevocations ?? []) {
			if (revocation.revocation.srcDomainId !== srcDomainId || revocation.revocation.dstDomainId !== dstDomainId)
				continue;
			if (!verifyXDomainLinkRevocation(revocation, state.ownerSignPub)) continue;
			if (revocation.revocation.revokedAt >= newest) return false;
		}
		return true;
	}

	public get sasFingerprint(): string {
		return fingerprint(this.identity.sign.pub);
	}

	public get rooted(): boolean {
		return this.state.ownerSignPub !== null;
	}

	public mintEnrollOwner(domainId: string, routerAddr: string, nowMs: number): EnrollOwnerPayload {
		const nonce = this.ambient.randomBytes(WIRE_NONCE_BYTES).toString("base64url");
		this.nonces.set(nonce, nowMs + this.nonceTtlMs);
		return {
			type: "enroll-owner",
			domainId,
			routerAddr,
			routerSignPub: this.identity.sign.pub,
			routerBoxPub: this.identity.box.pub,
			nonce,
		};
	}

	public registerNonceCleanup(nonce: string, cleanup: () => void): void {
		this.nonceCleanups.set(nonce, cleanup);
	}

	public async redeemEnrollOwner(
		nonce: string,
		ownerSignPub: string,
		ownerBoxPub: string,
		nowMs: number,
	): Promise<string | null> {
		const expiresAt = this.nonces.get(nonce);
		this.nonces.delete(nonce);
		const cleanup = this.nonceCleanups.get(nonce);
		if (cleanup) {
			this.nonceCleanups.delete(nonce);
			try {
				cleanup();
			} catch {}
		}
		if (expiresAt === undefined) return "unknown or already-redeemed enrollment nonce";
		if (nowMs > expiresAt) return "enrollment nonce expired";
		return this.transition((state) => {
			if (state.ownerSignPub && state.ownerSignPub !== ownerSignPub)
				return { commit: false, value: "Domain already rooted at a different owner" };
			state.ownerSignPub = ownerSignPub;
			state.ownerBoxPub = ownerBoxPub;
			return { commit: true, next: state, value: null };
		});
	}

	public admit(signed: SignedAdmission): Promise<string | null> {
		return this.transition((state) => {
			if (!state.ownerSignPub) return { commit: false, value: "Domain not rooted" };
			if (!verifyAdmission(signed, state.ownerSignPub))
				return { commit: false, value: "admission not owner-signed" };
			const a = signed.admission;
			if (a.kind === "gateway" && !a.gatewayId)
				return { commit: false, value: "gateway admission missing gatewayId" };
			if (a.kind === "console" && a.gatewayId)
				return { commit: false, value: "console admission must not carry a gatewayId" };
			const dup = state.admissions.some(
				(s) => s.admission.signPub === a.signPub && s.admission.nonce === a.nonce,
			);
			if (dup) return { commit: false, value: null };
			state.admissions.push(signed);
			return { commit: true, next: state, value: null };
		});
	}

	public revoke(signed: SignedRevocation, onAccepted?: () => void): Promise<string | null> {
		const ownerSignPub = this.state.ownerSignPub;
		const staged = !!ownerSignPub && verifyRevocation(signed, ownerSignPub);
		const alreadyPending = this.pendingRevocations.has(this.revocationKey(signed));
		if (staged) this.stageRevocation(signed);
		return this.transition((state) => {
			if (!state.ownerSignPub) return { commit: false, value: "Domain not rooted" };
			if (!verifyRevocation(signed, state.ownerSignPub))
				return { commit: false, value: "revocation not owner-signed" };
			this.stageRevocation(signed);
			onAccepted?.();
			state.revocations.push(signed);
			return { commit: true, next: state, value: null };
		}).then((error) => {
			if (error === null) this.clearRevocation(signed);
			else if (staged && !alreadyPending) this.clearRevocation(signed);
			return error;
		});
	}

	public retire(
		signed: SignedRevocation,
		registered: { gatewayId: string; signPub: string },
		onAccepted?: () => void,
	): Promise<string | null> {
		const ownerSignPub = this.state.ownerSignPub;
		const staged =
			!!ownerSignPub &&
			verifySelfRevocation(signed, registered.gatewayId) &&
			signed.revocation.signPub === registered.signPub;
		const alreadyPending = this.pendingRevocations.has(this.revocationKey(signed));
		if (staged) this.stageRevocation(signed);
		return this.transition((state) => {
			if (!state.ownerSignPub) return { commit: false, value: "Domain not rooted" };
			if (!verifySelfRevocation(signed, registered.gatewayId))
				return { commit: false, value: "revocation not self-signed" };
			if (signed.revocation.signPub !== registered.signPub)
				return { commit: false, value: "revocation signer does not match gateway" };
			const duplicate = state.revocations.some(
				(r) =>
					r.revocation.signPub === signed.revocation.signPub &&
					r.revocation.nonce === signed.revocation.nonce,
			);
			if (duplicate) {
				this.stageRevocation(signed);
				onAccepted?.();
				return { commit: false, value: null };
			}
			const live = resolveAdmitted(state.admissions, state.revocations, state.ownerSignPub, registered.signPub);
			if (live?.kind !== "gateway" || live.gatewayId !== registered.gatewayId)
				return { commit: false, value: "gateway is not admitted" };
			if (Math.abs(this.ambient.now() - signed.revocation.issuedAt) > REGISTER_MAX_SKEW_MS)
				return { commit: false, value: "self revocation is stale" };
			this.stageRevocation(signed);
			onAccepted?.();
			state.revocations.push(signed);
			return { commit: true, next: state, value: null };
		}).then((error) => {
			if (error === null) this.clearRevocation(signed);
			else if (staged && !alreadyPending) this.clearRevocation(signed);
			return error;
		});
	}

	public addLinkEdge(signed: SignedXDomainLinkEdge): Promise<string | null> {
		return this.transition((state) => {
			if (!state.ownerSignPub) return { commit: false, value: "Domain not rooted" };
			if (!verifyXDomainLinkEdge(signed, state.ownerSignPub))
				return { commit: false, value: "link edge not owner-signed" };
			if (signed.edge.srcDomainId !== this.domainId)
				return { commit: false, value: "link edge srcDomainId does not match this Domain" };
			state.linkEdges ??= [];
			const dup = state.linkEdges.some(
				(e) => e.edge.srcDomainId === signed.edge.srcDomainId && e.edge.nonce === signed.edge.nonce,
			);
			if (dup) return { commit: false, value: null };
			const nullified = (state.linkRevocations ?? []).some(
				(r) =>
					r.revocation.srcDomainId === signed.edge.srcDomainId &&
					r.revocation.dstDomainId === signed.edge.dstDomainId &&
					verifyXDomainLinkRevocation(r, state.ownerSignPub as string) &&
					r.revocation.revokedAt >= signed.edge.issuedAt,
			);
			if (nullified) return { commit: false, value: null };
			state.linkEdges.push(signed);
			return { commit: true, next: state, value: null };
		});
	}

	public removeLinkEdge(signed: SignedXDomainLinkRevocation): Promise<string | null> {
		const rev = signed.revocation;
		const edgeKey = this.edgeKey(rev.srcDomainId, rev.dstDomainId);
		const staged =
			!!this.state.ownerSignPub &&
			verifyXDomainLinkRevocation(signed, this.state.ownerSignPub) &&
			rev.srcDomainId === this.domainId &&
			this.hasLinkEdgeIn(this.state, rev.srcDomainId, rev.dstDomainId) &&
			this.latestEdgeIssuedAt(this.state, rev.srcDomainId, rev.dstDomainId) <= rev.revokedAt;
		const alreadyPending = this.pendingEdgeRemovals.has(edgeKey);
		if (staged) this.pendingEdgeRemovals.add(edgeKey);
		return this.transition((state) => {
			if (!state.ownerSignPub) return { commit: false, value: "Domain not rooted" };
			if (!verifyXDomainLinkRevocation(signed, state.ownerSignPub))
				return { commit: false, value: "revocation not owner-signed" };
			const rev = signed.revocation;
			if (rev.srcDomainId !== this.domainId)
				return { commit: false, value: "revocation srcDomainId does not match this Domain" };
			if (
				this.hasLinkEdgeIn(state, rev.srcDomainId, rev.dstDomainId) &&
				this.latestEdgeIssuedAt(state, rev.srcDomainId, rev.dstDomainId) <= rev.revokedAt
			)
				this.pendingEdgeRemovals.add(edgeKey);
			state.linkRevocations ??= [];
			const dup = state.linkRevocations.some(
				(r) =>
					r.revocation.srcDomainId === rev.srcDomainId &&
					r.revocation.dstDomainId === rev.dstDomainId &&
					r.revocation.nonce === rev.nonce,
			);
			const remaining = (state.linkEdges ?? []).filter(
				(e) =>
					!(
						e.edge.srcDomainId === rev.srcDomainId &&
						e.edge.dstDomainId === rev.dstDomainId &&
						e.edge.issuedAt <= rev.revokedAt
					),
			);
			const edgesChanged = remaining.length !== (state.linkEdges?.length ?? 0);
			if (dup && !edgesChanged) return { commit: false, value: null };
			if (!dup) state.linkRevocations.push(signed);
			state.linkEdges = remaining;
			return { commit: true, next: state, value: null };
		}).then((error) => {
			if (error === null || (staged && !alreadyPending)) this.pendingEdgeRemovals.delete(edgeKey);
			return error;
		});
	}

	public async dropLinkEdge(dstDomainId: string): Promise<WriteOutcome> {
		const edgeKey = this.edgeKey(this.domainId, dstDomainId);
		if (this.hasLinkEdgeIn(this.state, this.domainId, dstDomainId)) this.pendingEdgeRemovals.add(edgeKey);
		try {
			await this.transition((state) => {
				if (this.hasLinkEdgeIn(state, this.domainId, dstDomainId)) this.pendingEdgeRemovals.add(edgeKey);
				const remaining = (state.linkEdges ?? []).filter(
					(e) => !(e.edge.srcDomainId === this.domainId && e.edge.dstDomainId === dstDomainId),
				);
				if (remaining.length === (state.linkEdges?.length ?? 0)) return { commit: false, value: undefined };
				state.linkEdges = remaining;
				return { commit: true, next: state, value: undefined };
			});
			this.pendingEdgeRemovals.delete(edgeKey);
			return "accepted";
		} catch (error) {
			return error instanceof PostRenameSyncError ? "durability_uncertain" : "durability_failure";
		}
	}

	private latestEdgeIssuedAt(state: EnrollmentState, srcDomainId: string, dstDomainId: string): number {
		let newest = Number.NEGATIVE_INFINITY;
		for (const edge of state.linkEdges ?? []) {
			if (edge.edge.srcDomainId !== srcDomainId || edge.edge.dstDomainId !== dstDomainId) continue;
			if (!state.ownerSignPub || !verifyXDomainLinkEdge(edge, state.ownerSignPub)) continue;
			newest = Math.max(newest, edge.edge.issuedAt);
		}
		return newest;
	}

	public hasLinkEdge(srcDomainId: string, dstDomainId: string): boolean {
		return (
			!this.pendingEdgeRemovals.has(this.edgeKey(srcDomainId, dstDomainId)) &&
			this.hasLinkEdgeIn(this.state, srcDomainId, dstDomainId)
		);
	}

	public linkEdgeId(srcDomainId: string, dstDomainId: string): string | null {
		if (!this.hasLinkEdge(srcDomainId, dstDomainId) || !this.state.ownerSignPub) return null;
		const edge = (this.state.linkEdges ?? [])
			.filter(
				(s) =>
					s.edge.srcDomainId === srcDomainId &&
					s.edge.dstDomainId === dstDomainId &&
					verifyXDomainLinkEdge(s, this.state.ownerSignPub as string),
			)
			.sort((a, b) => b.edge.issuedAt - a.edge.issuedAt)[0];
		return edge?.signature ?? null;
	}

	public getDomainSnapshot(): DomainSnapshot | null {
		if (!this.state.ownerSignPub) return null;
		return structuredClone({
			ownerSignPub: this.state.ownerSignPub,
			admissions: this.state.admissions,
			revocations: [...this.state.revocations, ...this.pendingRevocations.values()],
			displayName: this.state.displayName ?? null,
		});
	}

	public getDomainStatus(): DomainStatus {
		if (this.state.ownerSignPub) return "rooted";
		if (this.state.pendingTenant) return "pending";
		return "unrooted";
	}

	public get displayName(): string | null {
		return this.state.displayName ?? this.state.pendingTenant?.displayName ?? null;
	}
}

export type EnrollRoute =
	| { kind: "domain"; domainId: string }
	| { kind: "tenant-authority" }
	| { kind: "refused"; error: string };

export interface EnrollRouteDeps {
	adminDomainId: string | null;

	rootedDomainFor: (ownerSignPub: string) => string | null;
}

export function resolveEnrollRoute(op: EnrollOp, deps: EnrollRouteDeps): EnrollRoute {
	switch (op.kind) {
		case "submit_admission": {
			const domainId = deps.rootedDomainFor(op.admission.ownerSignPub);
			return domainId ? { kind: "domain", domainId } : { kind: "refused", error: "admission not owner-signed" };
		}
		case "submit_revocation": {
			const domainId = deps.rootedDomainFor(op.revocation.ownerSignPub);
			return domainId ? { kind: "domain", domainId } : { kind: "refused", error: "revocation not owner-signed" };
		}
		case "submit_xdomain_link":
			return { kind: "domain", domainId: op.edge.edge.srcDomainId };
		case "revoke_xdomain_link":
			return { kind: "domain", domainId: op.revocation.revocation.srcDomainId };
		case "delete_domain":
			return { kind: "tenant-authority" };
		case "enroll_redeem":
		case "provision_tenant":
		case "remove_tenant":
		case "set_display_name":
			return deps.adminDomainId
				? { kind: "domain", domainId: deps.adminDomainId }
				: { kind: "refused", error: "no admin Domain" };
	}
}

export async function dispatchEnrollOp(
	c: EnrollmentCoordinator,
	op: EnrollOp,
	tenant?: TenantAdmin | null,
	beforeRevocationCommit?: () => void,
): Promise<EnrollResult> {
	let err: string | null;
	switch (op.kind) {
		case "enroll_redeem":
			return { ok: false, error: "enroll_redeem is retired" };
		case "submit_admission":
			err = await c.admit(op.admission);
			break;
		case "submit_revocation":
			err = await c.revoke(op.revocation, beforeRevocationCommit);
			break;
		case "submit_xdomain_link":
			err = await c.addLinkEdge(op.edge);
			break;
		case "revoke_xdomain_link":
			err = await c.removeLinkEdge(op.revocation);
			break;
		case "provision_tenant":
			if (!tenant) return { ok: false, error: "tenant administration not available" };
			return tenant.provisionTenant(op.provision);
		case "remove_tenant":
			if (!tenant) return { ok: false, error: "tenant administration not available" };
			return tenant.removeTenant(op.removal);
		case "set_display_name":
			if (!tenant) return { ok: false, error: "tenant administration not available" };
			return tenant.setDisplayName(op.rename);
		case "delete_domain":
			if (!tenant) return { ok: false, error: "tenant administration not available" };
			return tenant.deleteDomain(op.deletion);
	}
	return err ? { ok: false, error: err } : { ok: true };
}

export function inMemoryEnrollmentStore(initial?: EnrollmentState): EnrollmentStore {
	let saved: EnrollmentState | null = initial ? structuredClone(initial) : null;
	return {
		load: () => (saved ? structuredClone(saved) : null),
		save: (state) => {
			saved = structuredClone(state);
		},
		mutateDomain: async (mutator) => {
			const current = saved ? structuredClone(saved) : null;
			const decision = mutator(current);
			if (decision.commit) {
				saved = decision.next === DELETE_SLICE ? null : structuredClone(decision.next);
			}
			return decision.value;
		},
	};
}
