// Shared owner request lifecycle.
// Outcomes stay local.

import type { Ambient, TimerHandle } from "../shared/ambient.js";
import type { DurableStore } from "../shared/durable-store.js";
import type { MIGRATING } from "../shared/migration-fence.js";

export interface OwnerRequestRow {
	requestId: string;
	sessionTarget: string;
	deadlineAt: number;
}

export type OwnerRequestOpened<R, A> =
	| { kind: "opened"; request: R; answer: Promise<A> }
	| { kind: "undeliverable"; reason: "migrating" | "unreachable" | "flooded" };

/** No owner answer. */
export type Lapse = "expired" | "withdrawn" | "ended";

/** What a restart retracts. */
export interface OpenStub {
	requestId: string;
	sessionTarget: string;
}

export interface OwnerRequestsDeps<R extends OwnerRequestRow, A> {
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	deadlineMs: number;
	/** Per-target request cap. */
	maxOpenPerTarget: number;
	/** Queued rows only. */
	deliver: (request: R) => boolean | typeof MIGRATING;
	/** Lapse result. */
	lapsed: (why: Lapse) => A;
	/** False retains ledger-backed stubs. */
	onSettled?: (request: R) => boolean;
	/** No-answer lapse. */
	onUnanswered?: (request: R) => void;
	/** Restart retraction ledger. */
	ledger?: Pick<DurableStore, "load" | "save">;
	/** Retain settled answers at least through deadline. */
	holdSettledMs?: number;
}

interface Pending<R, A> {
	request: R;
	timer: TimerHandle | null;
	answer: Promise<A>;
	settle: (answer: A) => void;
	settled: boolean;
	/** In-flight answer claim. */
	claimed: boolean;
	/** The owner answered it. */
	answered: boolean;
	/** Answer retention deadline. */
	keepUntil: number;
}

/** Claimed answers receive grace. */
export const CLAIMED_ANSWER_GRACE_MS = 30 * 60 * 1000;

export interface Held<R, A> {
	request: R;
	answer: Promise<A>;
}

function stubsOf(raw: unknown): OpenStub[] {
	const open = (raw as { open?: unknown } | null)?.open;
	if (!Array.isArray(open)) return [];
	return open.filter(
		(stub): stub is OpenStub => typeof stub?.requestId === "string" && typeof stub?.sessionTarget === "string",
	);
}

export function createOwnerRequests<R extends OwnerRequestRow, A>(deps: OwnerRequestsDeps<R, A>) {
	const { ambient } = deps;
	const pending = new Map<string, Pending<R, A>>();
	// Restored open requests.
	let stale = stubsOf(deps.ledger?.load() ?? null);

	const saveLedger = () => {
		if (!deps.ledger) return;
		const live = [...pending.values()]
			.filter((entry) => !entry.settled)
			.map(({ request }) => ({ requestId: request.requestId, sessionTarget: request.sessionTarget }));
		deps.ledger.save({ v: 1, open: [...stale, ...live] });
	};

	const forget = (requestId: string): boolean => {
		const entry = pending.get(requestId);
		if (!entry) return false;
		if (entry.timer) ambient.clearTimer(entry.timer);
		pending.delete(requestId);
		return true;
	};

	/** Unanswered and inside its deadline, or claimed. */
	const isOpen = (entry: Pending<R, A>): boolean =>
		!entry.settled && (entry.claimed || ambient.now() < entry.request.deadlineAt);

	const openFor = (sessionTarget: string): number => {
		let count = 0;
		for (const entry of pending.values())
			if (isOpen(entry) && entry.request.sessionTarget === sessionTarget) count += 1;
		return count;
	};

	/** One lapse for timer and read. */
	const expire = (entry: Pending<R, A>): void => {
		if (entry.settled) return;
		entry.settle(deps.lapsed("expired"));
		try {
			deps.onUnanswered?.(entry.request);
		} catch {}
	};

	/** Overdue reads settle; retention expires them. */
	const lapsedAt = (requestId: string, entry: Pending<R, A>): boolean => {
		if (entry.claimed && !entry.settled) return false;
		if (ambient.now() >= entry.request.deadlineAt) expire(entry);
		if (!entry.settled || ambient.now() < entry.keepUntil) return false;
		forget(requestId);
		return true;
	};

	/** Answers expire at keepUntil; requests at deadline. */
	const arm = (requestId: string, entry: Pending<R, A>, atMs: number) => {
		if (entry.timer) ambient.clearTimer(entry.timer);
		entry.timer = ambient.setTimer(
			() => {
				entry.timer = null;
				if (entry.claimed && !entry.settled) return;
				expire(entry);
				if (ambient.now() >= entry.keepUntil) pending.delete(requestId);
			},
			Math.max(0, atMs - ambient.now()),
		);
	};

	const open = (input: {
		sessionTarget: string;
		build: (requestId: string, deadlineAt: number) => R;
	}): OwnerRequestOpened<R, A> => {
		if (openFor(input.sessionTarget) >= deps.maxOpenPerTarget) return { kind: "undeliverable", reason: "flooded" };
		const requestId = ambient.newId();
		const request = input.build(requestId, ambient.now() + deps.deadlineMs);
		let resolve: (answer: A) => void = () => undefined;
		const answer = new Promise<A>((done) => {
			resolve = done;
		});
		const entry: Pending<R, A> = {
			request,
			answer,
			settled: false,
			claimed: false,
			answered: false,
			timer: null,
			keepUntil: request.deadlineAt,
			settle: (result) => {
				if (entry.settled) return;
				entry.settled = true;
				const held = deps.holdSettledMs ?? 0;
				const hold = entry.claimed ? Math.max(CLAIMED_ANSWER_GRACE_MS, held) : held;
				if (hold > 0) {
					entry.keepUntil = Math.max(request.deadlineAt, ambient.now() + hold);
					arm(requestId, entry, entry.keepUntil);
				}
				resolve(result);
				let retracted = true;
				try {
					retracted = deps.onSettled?.(request) !== false;
				} catch {
					retracted = false;
				}
				// Unqueued retractions await activation.
				if (!retracted && deps.ledger) stale = [...stale, { requestId, sessionTarget: request.sessionTarget }];
				saveLedger();
			},
		};
		// Persist before retraction.
		pending.set(requestId, entry);
		saveLedger();
		let delivered: boolean | typeof MIGRATING;
		try {
			delivered = deps.deliver(request);
		} catch (error) {
			pending.delete(requestId);
			saveLedger();
			throw error;
		}
		if (delivered !== true) {
			pending.delete(requestId);
			saveLedger();
			return { kind: "undeliverable", reason: delivered === false ? "unreachable" : "migrating" };
		}
		// Uncollected answers expire.
		arm(requestId, entry, request.deadlineAt);
		return { kind: "opened", request, answer };
	};

	/** Retries join open requests. */
	const find = (match: (request: R) => boolean): Held<R, A> | undefined => {
		for (const entry of pending.values()) if (isOpen(entry) && match(entry.request)) return entry;
		return undefined;
	};

	/** Open, unclaimed, unexpired. */
	const live = (requestId: string): R | null => {
		const entry = pending.get(requestId);
		if (!entry || entry.claimed) return null;
		lapsedAt(requestId, entry);
		return entry.settled ? null : entry.request;
	};

	/** Claimed until settlement. */
	const claim = (requestId: string): R | null => {
		const request = live(requestId);
		const entry = pending.get(requestId);
		if (!request || !entry) return null;
		entry.claimed = true;
		entry.answered = true;
		if (entry.timer) ambient.clearTimer(entry.timer);
		entry.timer = null;
		return request;
	};

	/** Single use. */
	const settle = (requestId: string, answer: A): boolean => {
		const entry = pending.get(requestId);
		if (!entry || entry.settled) return false;
		entry.answered = true;
		entry.settle(answer);
		return true;
	};

	/** Detect repeated answers. */
	const answered = (requestId: string): boolean => pending.get(requestId)?.answered === true;

	/** Opener-only, through retention. */
	const collect = (requestId: string, sessionTarget: string): Held<R, A> | undefined => {
		const entry = pending.get(requestId);
		if (!entry || entry.request.sessionTarget !== sessionTarget || lapsedAt(requestId, entry)) return undefined;
		return entry;
	};

	/** Opener withdraws unanswered requests. */
	const withdraw = (requestId: string, sessionTarget: string): boolean => {
		const entry = pending.get(requestId);
		if (!entry || entry.settled || entry.claimed || entry.request.sessionTarget !== sessionTarget) return false;
		entry.settle(deps.lapsed("withdrawn"));
		return forget(requestId);
	};

	/** In-flight answers complete. */
	const sessionEnded = (sessionTarget: string): void => {
		for (const [requestId, entry] of [...pending]) {
			if (entry.request.sessionTarget !== sessionTarget || entry.claimed) continue;
			entry.settle(deps.lapsed("ended"));
			// Held answers outlive the session.
			if (!deps.holdSettledMs || ambient.now() >= entry.keepUntil) forget(requestId);
		}
	};

	/** Adapter settles matching requests. */
	const closeWhere = (match: (request: R) => boolean, answer: A): void => {
		for (const [requestId, entry] of [...pending]) {
			if (entry.settled || entry.claimed || !match(entry.request)) continue;
			entry.settle(answer);
			forget(requestId);
		}
	};

	/** Keep stubs until queued. */
	const retractStale = (retract: (stub: OpenStub) => boolean): void => {
		if (stale.length === 0) return;
		const kept = stale.filter((stub) => {
			try {
				return !retract(stub);
			} catch {
				return true;
			}
		});
		if (kept.length === stale.length) return;
		stale = kept;
		saveLedger();
	};

	return {
		open,
		find,
		live,
		claim,
		settle,
		answered,
		collect,
		forget,
		withdraw,
		sessionEnded,
		closeWhere,
		retractStale,
	};
}

export type OwnerRequests<R extends OwnerRequestRow, A> = ReturnType<typeof createOwnerRequests<R, A>>;
