import type { Ambient, IntervalHandle, TimerHandle } from "./ambient.js";
import type { ReturnRoute } from "./federation-protocol.js";
import { type Address, parseStoreKey } from "./session-id.js";

export type JobState = "waiting" | "timed_out" | "stored";

/** Store keys provide trusted share-match inputs. */
function jobAddress(id: string): Address | null {
	const k = parseStoreKey(id);
	return k?.kind === "conv" ? k.address : null;
}

export type LocalReply = { kind: "owner"; ownerId: string } | { kind: "conversation"; conversationId: string };

/** Reply contract is immutable. */
export type JobContract =
	| { kind: "local"; reply: LocalReply }
	| { kind: "outbound"; reply: LocalReply; dstDomainId: string | null }
	| { kind: "inbound"; route: ReturnRoute; dstDomainId: string | null };

export function dstDomainOf(contract: JobContract): string | null {
	return contract.kind === "local" ? null : contract.dstDomainId;
}

function sameReply(a: LocalReply, b: LocalReply): boolean {
	if (a.kind === "owner") return b.kind === "owner" && a.ownerId === b.ownerId;
	return b.kind === "conversation" && a.conversationId === b.conversationId;
}

export function sameContract(a: JobContract, b: JobContract): boolean {
	if (a.kind === "local" && b.kind === "local") return sameReply(a.reply, b.reply);
	if (a.kind === "outbound" && b.kind === "outbound")
		return a.dstDomainId === b.dstDomainId && sameReply(a.reply, b.reply);
	if (a.kind === "inbound" && b.kind === "inbound")
		return (
			a.dstDomainId === b.dstDomainId &&
			a.route.srcGateway === b.route.srcGateway &&
			a.route.srcConversationId === b.route.srcConversationId &&
			a.route.srcSession === b.route.srcSession
		);
	return false;
}

/** Validate encoded origin. */
export function contractRefusal(id: string, contract: JobContract): string | null {
	const key = parseStoreKey(id);
	if (key?.kind !== "conv") return `"${id}" is not a conversation session key`;
	if (contract.kind === "inbound") {
		if (contract.route.srcSession !== id) return `return route names another session`;
		if (contract.route.srcConversationId !== key.conversationId)
			return `return route conversation does not match the session key`;
		return null;
	}
	const claimed = contract.reply.kind === "owner" ? contract.reply.ownerId : contract.reply.conversationId;
	if (claimed !== key.conversationId) return `reply conversation does not match the session key`;
	return null;
}

interface JobEntry<T> {
	id: string;
	from: string;
	to: string;
	contract: JobContract;
	persistent: boolean;
	state: JobState;
	createdAt: number;
	holders: number;
	committed: boolean;
	timer: TimerHandle | null;
	resolve: ((result: WaitResult<T>) => void) | null;
	storedResult: T | null;
}

export interface WaitResult<T> {
	delivered: boolean;
	result?: T;
	error?: string;
}

export interface Reservation {
	id: string;
}

export type ReserveResult = { kind: "ok"; reservation: Reservation } | { kind: "conflict"; reason: string };

export interface CrossDomainBinding {
	/** Verified bindings gate replies, never bare friend gateway ids. */
	dstDomainId: string | null;
	keyGateway: string | null;
	returnGateway: string | null;
}

export interface DeliverMeta {
	delivered: boolean;
	from: string;
	to: string;
	contract: JobContract;
	persistent: boolean;
}

export interface PersistentJobSnapshot<T> {
	id: string;
	from: string;
	to: string;
	contract: JobContract;
	state: JobState;
	createdAt: number;
	storedResult: T | null;
}

export interface PersistedJobs<T> {
	version: 2;
	jobs: PersistentJobSnapshot<T>[];
}

export interface RestoreReport {
	restored: number;
	/** Rejected rows lacked origins. */
	rejected: number;
	legacy: boolean;
}

function readContract(raw: unknown): JobContract | null {
	if (raw === null || typeof raw !== "object") return null;
	const c = raw as Record<string, unknown>;
	const domain =
		c.dstDomainId === null || typeof c.dstDomainId === "string" ? (c.dstDomainId as string | null) : null;
	if (c.kind === "inbound") {
		const r = c.route as Record<string, unknown> | undefined;
		if (!r || typeof r.srcGateway !== "string" || typeof r.srcSession !== "string") return null;
		if (typeof r.srcConversationId !== "string") return null;
		return {
			kind: "inbound",
			route: { srcGateway: r.srcGateway, srcConversationId: r.srcConversationId, srcSession: r.srcSession },
			dstDomainId: domain,
		};
	}
	if (c.kind !== "local" && c.kind !== "outbound") return null;
	const reply = readReply(c.reply);
	if (!reply) return null;
	return c.kind === "local" ? { kind: "local", reply } : { kind: "outbound", reply, dstDomainId: domain };
}

function readReply(raw: unknown): LocalReply | null {
	if (raw === null || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.kind === "owner" && typeof r.ownerId === "string") return { kind: "owner", ownerId: r.ownerId };
	if (r.kind === "conversation" && typeof r.conversationId === "string")
		return { kind: "conversation", conversationId: r.conversationId };
	return null;
}

function migrateLegacyContract(row: Record<string, unknown>): JobContract | null {
	const route = row.returnRoute as Record<string, unknown> | null | undefined;
	if (!route) return null;
	if (typeof route.srcGateway !== "string" || typeof route.srcSession !== "string") return null;
	if (typeof route.srcConversationId !== "string") return null;
	return {
		kind: "inbound",
		route: {
			srcGateway: route.srcGateway,
			srcConversationId: route.srcConversationId,
			srcSession: route.srcSession,
		},
		dstDomainId: typeof row.dstDomainId === "string" ? row.dstDomainId : null,
	};
}

function readState(raw: unknown): JobState | null {
	return raw === "waiting" || raw === "stored" || raw === "timed_out" ? raw : null;
}

export class PendingJobStore<T> {
	private entries = new Map<string, JobEntry<T>>();
	private ttlMs: number;
	private cleanupTimer: IntervalHandle | null = null;
	private onCrossDomainJobChange: (() => void) | undefined;

	constructor(
		ttlMs: number,
		private readonly ambient: Ambient,
		onCrossDomainJobChange?: () => void,
	) {
		this.ttlMs = ttlMs;
		this.onCrossDomainJobChange = onCrossDomainJobChange;
	}

	private notifyCrossDomainJobChange(entry: JobEntry<T> | undefined): void {
		if (entry?.persistent && entry.contract.kind === "inbound") this.onCrossDomainJobChange?.();
	}

	get size(): number {
		return this.entries.size;
	}

	startCleanup(intervalMs = 60_000): void {
		if (this.cleanupTimer) return;
		this.cleanupTimer = this.ambient.setInterval(() => this.sweep(), intervalMs);
	}

	stopCleanup(): void {
		if (this.cleanupTimer) {
			this.ambient.clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	/** An equal contract refreshes; a different one is refused, never merged. */
	reserve(
		id: string,
		from: string,
		to: string,
		contract: JobContract,
		opts: { persistent?: boolean } = {},
	): ReserveResult {
		const refusal = contractRefusal(id, contract);
		if (refusal) return { kind: "conflict", reason: refusal };
		const persistent = opts.persistent ?? false;
		const existing = this.entries.get(id);
		if (existing) {
			if (!sameContract(existing.contract, contract))
				return { kind: "conflict", reason: `"${id}" is already anchored to a different origin` };
			existing.from = from;
			existing.to = to;
			existing.persistent = persistent || existing.persistent;
			// Refresh extends lifetime.
			existing.createdAt = this.ambient.now();
			existing.holders++;
			this.notifyCrossDomainJobChange(existing);
			return { kind: "ok", reservation: { id } };
		}
		const entry: JobEntry<T> = {
			id,
			from,
			to,
			contract,
			persistent,
			state: "waiting",
			createdAt: this.ambient.now(),
			holders: 1,
			committed: false,
			timer: null,
			resolve: null,
			storedResult: null,
		};
		this.entries.set(id, entry);
		this.notifyCrossDomainJobChange(entry);
		return { kind: "ok", reservation: { id } };
	}

	commit(reservation: Reservation): void {
		const entry = this.entries.get(reservation.id);
		if (!entry) return;
		entry.committed = true;
		if (entry.holders > 0) entry.holders--;
	}

	/** Abort uncommitted anchors. */
	abort(reservation: Reservation): void {
		const entry = this.entries.get(reservation.id);
		if (!entry) return;
		if (entry.holders > 0) entry.holders--;
		if (entry.holders > 0 || entry.committed) return;
		if (entry.state !== "waiting" || entry.storedResult !== null || entry.resolve) return;
		if (entry.timer) this.ambient.clearTimer(entry.timer);
		this.entries.delete(entry.id);
		this.notifyCrossDomainJobChange(entry);
	}

	waitForResult(id: string, timeoutMs: number): Promise<WaitResult<T>> {
		const entry = this.entries.get(id);
		if (!entry) return Promise.resolve({ delivered: false });
		return new Promise((resolve) => {
			entry.resolve = resolve;
			entry.timer = this.ambient.setTimer(() => {
				entry.state = "timed_out";
				entry.timer = null;
				entry.resolve = null;
				resolve({ delivered: false });
			}, timeoutMs);
		});
	}

	targetOf(id: string): string | undefined {
		return this.entries.get(id)?.to;
	}

	askerOf(id: string): string | undefined {
		return this.entries.get(id)?.from;
	}

	deliver(id: string, result: T): DeliverMeta | false {
		const entry = this.entries.get(id);
		if (!entry) return false;

		const meta = (): DeliverMeta => ({
			delivered: true,
			from: entry.from,
			to: entry.to,
			contract: entry.contract,
			persistent: entry.persistent,
		});

		if (entry.state === "waiting" && entry.resolve) {
			if (entry.timer) this.ambient.clearTimer(entry.timer);
			entry.timer = null;
			entry.resolve({ delivered: true, result });
			entry.resolve = null;
			if (!entry.persistent) {
				this.entries.delete(id);
			} else {
				entry.state = "stored";
				entry.storedResult = result;
				entry.createdAt = this.ambient.now();
			}
			this.notifyCrossDomainJobChange(entry);
			return meta();
		}

		if (entry.state === "waiting" && !entry.resolve) {
			entry.state = "stored";
			entry.storedResult = result;
			entry.createdAt = this.ambient.now();
			this.notifyCrossDomainJobChange(entry);
			return meta();
		}

		if (entry.state === "timed_out") {
			entry.state = "stored";
			entry.storedResult = result;
			entry.createdAt = this.ambient.now();
			this.notifyCrossDomainJobChange(entry);
			return meta();
		}

		if (entry.state === "stored") {
			entry.storedResult = result;
			entry.createdAt = this.ambient.now();
			this.notifyCrossDomainJobChange(entry);
			return meta();
		}

		return false;
	}

	remove(id: string): void {
		const entry = this.entries.get(id);
		if (entry?.timer) this.ambient.clearTimer(entry.timer);
		this.entries.delete(id);
		this.notifyCrossDomainJobChange(entry);
	}

	// Unlink expiry settles waiters immediately and removes jobs.
	expireByDomain(dstDomainId: string, error = "cross-domain link unlinked"): number {
		let expired = 0;
		for (const [id, entry] of this.entries) {
			if (dstDomainOf(entry.contract) !== dstDomainId) continue;
			if (entry.timer) this.ambient.clearTimer(entry.timer);
			entry.timer = null;
			entry.state = "timed_out";
			const resolve = entry.resolve;
			entry.resolve = null;
			resolve?.({ delivered: false, error });
			this.entries.delete(id);
			this.notifyCrossDomainJobChange(entry);
			expired++;
		}
		return expired;
	}

	// Session expiry matches the canonical store-key address.
	expireBySession(sessionTarget: string, dstDomainId: string, error = "cross-domain session unshared"): number {
		let expired = 0;
		for (const [id, entry] of this.entries) {
			if (dstDomainOf(entry.contract) !== dstDomainId) continue;
			if (jobAddress(entry.id)?.canonical !== sessionTarget) continue;
			if (entry.timer) this.ambient.clearTimer(entry.timer);
			entry.timer = null;
			entry.state = "timed_out";
			const resolve = entry.resolve;
			entry.resolve = null;
			resolve?.({ delivered: false, error });
			this.entries.delete(id);
			this.notifyCrossDomainJobChange(entry);
			expired++;
		}
		return expired;
	}

	// Persistent results remain available after polling.
	poll(id: string): T | null | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;

		if (entry.state === "stored" && entry.storedResult !== null) {
			const result = entry.storedResult;
			if (!entry.persistent) this.entries.delete(id);
			return result;
		}

		if (entry.state === "timed_out") {
			return null;
		}

		return undefined;
	}

	getIdsForTeam(team: string): string[] {
		const ids: string[] = [];
		for (const [id, entry] of this.entries) {
			if (entry.to === team) ids.push(id);
		}
		return ids;
	}

	crossDomainBinding(id: string): CrossDomainBinding | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		return {
			dstDomainId: dstDomainOf(entry.contract),
			keyGateway: jobAddress(entry.id)?.gateway ?? null,
			returnGateway: entry.contract.kind === "inbound" ? entry.contract.route.srcGateway : null,
		};
	}

	liveCrossDomainJobIds(
		sessionTarget: string,
		isCrossDomainPeer: (gatewayId: string) => boolean,
		maxAgeMs: number,
		now: number,
	): string[] {
		const ids: string[] = [];
		for (const entry of this.entries.values()) {
			if (!entry.persistent || entry.contract.kind !== "inbound") continue;
			if (now - entry.createdAt > maxAgeMs) continue;
			if (!isCrossDomainPeer(entry.contract.route.srcGateway)) continue;
			if (jobAddress(entry.id)?.canonical === sessionTarget) ids.push(entry.id);
		}
		return ids;
	}

	hasLiveCrossDomainThread(
		sessionTarget: string,
		isCrossDomainPeer: (gatewayId: string) => boolean,
		maxAgeMs: number,
		now: number,
	): boolean {
		for (const entry of this.entries.values()) {
			if (!entry.persistent || entry.contract.kind !== "inbound") continue;
			if (now - entry.createdAt > maxAgeMs) continue;
			if (!isCrossDomainPeer(entry.contract.route.srcGateway)) continue;
			if (jobAddress(entry.id)?.canonical === sessionTarget) return true;
		}
		return false;
	}

	listAll(): Array<{ id: string; from: string; to: string; state: JobState; persistent: boolean }> {
		return [...this.entries.values()].map(({ id, from, to, state, persistent }) => ({
			id,
			from,
			to,
			state,
			persistent,
		}));
	}

	snapshot(): PersistedJobs<T> {
		const jobs: PersistentJobSnapshot<T>[] = [];
		for (const e of this.entries.values()) {
			if (!e.persistent) continue;
			jobs.push({
				id: e.id,
				from: e.from,
				to: e.to,
				contract: e.contract,
				state: e.state === "timed_out" ? "waiting" : e.state,
				createdAt: e.createdAt,
				storedResult: e.storedResult,
			});
		}
		return { version: 2, jobs };
	}

	/** Reject unverifiable origins. */
	restore(raw: unknown): RestoreReport {
		const legacy = Array.isArray(raw);
		const rows: unknown[] = legacy
			? raw
			: raw !== null && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown[] }).jobs)
				? ((raw as { jobs: unknown[] }).jobs ?? [])
				: [];
		let restored = 0;
		let rejected = 0;
		for (const row of rows) {
			if (row === null || typeof row !== "object") {
				rejected++;
				continue;
			}
			const r = row as Record<string, unknown>;
			const state = readState(r.state);
			const contract = legacy ? migrateLegacyContract(r) : readContract(r.contract);
			if (
				typeof r.id !== "string" ||
				typeof r.from !== "string" ||
				typeof r.to !== "string" ||
				typeof r.createdAt !== "number" ||
				!state ||
				!contract ||
				contractRefusal(r.id, contract)
			) {
				rejected++;
				continue;
			}
			if (this.entries.has(r.id)) continue;
			this.entries.set(r.id, {
				id: r.id,
				from: r.from,
				to: r.to,
				contract,
				persistent: true,
				state,
				createdAt: r.createdAt,
				holders: 0,
				committed: true,
				timer: null,
				resolve: null,
				storedResult: (r.storedResult ?? null) as T | null,
			});
			restored++;
		}
		return { restored, rejected, legacy };
	}

	private sweep(): void {
		const now = this.ambient.now();
		for (const [id, entry] of this.entries) {
			if (entry.persistent) continue;
			if (entry.state !== "waiting" && now - entry.createdAt > this.ttlMs) {
				if (entry.timer) this.ambient.clearTimer(entry.timer);
				this.entries.delete(id);
			}
		}
	}
}
