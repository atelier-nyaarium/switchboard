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

export type Lapse = "expired" | "withdrawn" | "ended";
export type SettledCause = Lapse | "answered" | "closed";

export interface CollectUntilInput {
	cause: SettledCause;
	at: number;
	deadlineAt: number;
}

export interface OpenStub {
	requestId: string;
	sessionTarget: string;
}

export interface OwnerRequestsDeps<R extends OwnerRequestRow, A> {
	ambient: Pick<Ambient, "now" | "newId" | "setTimer" | "clearTimer">;
	deadlineMs: number;
	maxOpenPerTarget: number;
	deliver: (request: R) => boolean | typeof MIGRATING;
	lapsed: (why: Lapse) => A;
	/** False keeps ledger-backed stubs. */
	onSettled?: (request: R) => boolean;
	onUnanswered?: (request: R) => void;
	ledger?: Pick<DurableStore, "load" | "save">;
	/** Adapter retention; past times retire. */
	collectUntil: (input: CollectUntilInput) => number;
}

type Phase<A, P> =
	| { tag: "waiting"; payload: P }
	| { tag: "claimed"; payload: P }
	| { tag: "settled"; answer: A; cause: SettledCause; collectUntil: number };

interface Entry<R, A, P> {
	request: R;
	phase: Phase<A, P>;
	answer: Promise<A>;
	resolve: (answer: A) => void;
	timer: TimerHandle | null;
}

type Event<A> =
	| { tag: "tick" }
	| { tag: "claim" }
	| { tag: "answer"; answer: A }
	| { tag: "withdraw"; sessionTarget: string }
	| { tag: "end" }
	| { tag: "close"; answer: A }
	| { tag: "take" };

export const CLAIMED_ANSWER_GRACE_MS = 30 * 60 * 1000;

export interface Held<R, A> {
	request: R;
	answer: Promise<A>;
}

export interface OpenHeld<R, A, P> extends Held<R, A> {
	payload: P;
}

function stubsOf(raw: unknown): OpenStub[] {
	const open = (raw as { open?: unknown } | null)?.open;
	if (!Array.isArray(open)) return [];
	return open.filter(
		(stub): stub is OpenStub => typeof stub?.requestId === "string" && typeof stub?.sessionTarget === "string",
	);
}

export function createOwnerRequests<R extends OwnerRequestRow, A, P = undefined>(deps: OwnerRequestsDeps<R, A>) {
	const { ambient } = deps;
	const pending = new Map<string, Entry<R, A, P>>();
	let stale = stubsOf(deps.ledger?.load() ?? null);

	const saveLedger = (excludeId?: string) => {
		if (!deps.ledger) return;
		const live = [...pending.entries()]
			.filter(([id, entry]) => id !== excludeId && entry.phase.tag !== "settled")
			.map(([, entry]) => ({ requestId: entry.request.requestId, sessionTarget: entry.request.sessionTarget }));
		deps.ledger.save({ v: 1, open: [...stale, ...live] });
	};

	const retire = (requestId: string): boolean => {
		const entry = pending.get(requestId);
		if (!entry) return false;
		if (entry.timer) ambient.clearTimer(entry.timer);
		entry.timer = null;
		pending.delete(requestId);
		saveLedger();
		return true;
	};

	/** The only phase mutator. */
	let step: (requestId: string, event: Event<A>) => boolean = () => false;

	const schedule = (entry: Entry<R, A, P>) => {
		if (entry.timer) ambient.clearTimer(entry.timer);
		entry.timer = null;
		const phase = entry.phase;
		if (phase.tag === "claimed") return;
		const at = phase.tag === "waiting" ? entry.request.deadlineAt : phase.collectUntil;
		let timer: TimerHandle;
		timer = ambient.setTimer(
			() => {
				if (entry.timer !== timer) return;
				entry.timer = null;
				step(entry.request.requestId, { tag: "tick" });
			},
			Math.max(0, at - ambient.now()),
		);
		entry.timer = timer;
	};

	const settleInto = (entry: Entry<R, A, P>, answer: A, cause: SettledCause) => {
		const at = ambient.now();
		let collectUntil = deps.collectUntil({ cause, at, deadlineAt: entry.request.deadlineAt });
		if (cause === "answered" && entry.phase.tag === "claimed") {
			collectUntil = Math.max(collectUntil, entry.request.deadlineAt, at + CLAIMED_ANSWER_GRACE_MS);
		}
		entry.resolve(answer);
		let retracted = true;
		try {
			retracted = deps.onSettled?.(entry.request) !== false;
		} catch {
			retracted = false;
		}
		if (cause === "expired") {
			try {
				deps.onUnanswered?.(entry.request);
			} catch {}
		}
		if (!retracted && deps.ledger) {
			stale = [...stale, { requestId: entry.request.requestId, sessionTarget: entry.request.sessionTarget }];
		}
		saveLedger(entry.request.requestId);
		return { tag: "settled", answer, cause, collectUntil } as const;
	};

	step = (requestId, event) => {
		const entry = pending.get(requestId);
		if (!entry) return false;
		const settle = (answer: A, cause: SettledCause): boolean => {
			entry.phase = settleInto(entry, answer, cause);
			if (entry.phase.collectUntil <= ambient.now()) retire(requestId);
			else schedule(entry);
			return true;
		};

		switch (event.tag) {
			case "tick": {
				if (entry.phase.tag === "waiting") {
					if (ambient.now() >= entry.request.deadlineAt) return settle(deps.lapsed("expired"), "expired");
					schedule(entry);
					return false;
				}
				if (entry.phase.tag === "settled") {
					if (ambient.now() >= entry.phase.collectUntil) return retire(requestId);
					schedule(entry);
				} else if (entry.phase.tag === "claimed") {
					schedule(entry);
				}
				return false;
			}
			case "claim": {
				if (entry.phase.tag !== "waiting") return false;
				if (ambient.now() >= entry.request.deadlineAt) {
					settle(deps.lapsed("expired"), "expired");
					return false;
				}
				entry.phase = { tag: "claimed", payload: entry.phase.payload };
				schedule(entry);
				return true;
			}
			case "answer": {
				if (entry.phase.tag === "settled") return false;
				if (entry.phase.tag === "waiting" && ambient.now() >= entry.request.deadlineAt) {
					settle(deps.lapsed("expired"), "expired");
					return false;
				}
				return settle(event.answer, "answered");
			}
			case "withdraw": {
				if (entry.phase.tag !== "waiting" || entry.request.sessionTarget !== event.sessionTarget) return false;
				if (ambient.now() >= entry.request.deadlineAt) {
					settle(deps.lapsed("expired"), "expired");
					return false;
				}
				return settle(deps.lapsed("withdrawn"), "withdrawn");
			}
			case "end": {
				if (entry.phase.tag !== "waiting") return false;
				if (ambient.now() >= entry.request.deadlineAt) return settle(deps.lapsed("expired"), "expired");
				return settle(deps.lapsed("ended"), "ended");
			}
			case "close": {
				if (entry.phase.tag !== "waiting") return false;
				if (ambient.now() >= entry.request.deadlineAt) {
					settle(deps.lapsed("expired"), "expired");
					return false;
				}
				return settle(event.answer, "closed");
			}
			case "take":
				return entry.phase.tag === "settled" ? retire(requestId) : false;
		}
	};

	const openFor = (sessionTarget: string): number => {
		let count = 0;
		for (const requestId of [...pending.keys()]) {
			step(requestId, { tag: "tick" });
			const entry = pending.get(requestId);
			if (!entry || entry.request.sessionTarget !== sessionTarget) continue;
			if (entry.phase.tag === "claimed" || entry.phase.tag === "waiting") count += 1;
		}
		return count;
	};

	const open = (input: {
		sessionTarget: string;
		requestId?: string;
		build: (requestId: string, deadlineAt: number) => R;
		payload: P;
	}): OwnerRequestOpened<R, A> => {
		if (openFor(input.sessionTarget) >= deps.maxOpenPerTarget) return { kind: "undeliverable", reason: "flooded" };
		const requestId = input.requestId ?? ambient.newId();
		if (pending.has(requestId) || stale.some((stub) => stub.requestId === requestId))
			return { kind: "undeliverable", reason: "unreachable" };
		const request = input.build(requestId, ambient.now() + deps.deadlineMs);
		let resolve: (answer: A) => void = () => undefined;
		const answer = new Promise<A>((done) => {
			resolve = done;
		});
		const entry: Entry<R, A, P> = {
			request,
			phase: { tag: "waiting", payload: input.payload },
			answer,
			resolve,
			timer: null,
		};
		pending.set(requestId, entry);
		saveLedger();
		let delivered: boolean | typeof MIGRATING;
		try {
			delivered = deps.deliver(request);
		} catch (error) {
			retire(requestId);
			throw error;
		}
		if (delivered !== true) {
			retire(requestId);
			return { kind: "undeliverable", reason: delivered === false ? "unreachable" : "migrating" };
		}
		schedule(entry);
		return { kind: "opened", request, answer };
	};

	const find = (match: (request: R) => boolean): OpenHeld<R, A, P> | undefined => {
		for (const requestId of [...pending.keys()]) {
			step(requestId, { tag: "tick" });
			const entry = pending.get(requestId);
			if (!entry || (entry.phase.tag !== "waiting" && entry.phase.tag !== "claimed")) continue;
			if (match(entry.request))
				return { request: entry.request, answer: entry.answer, payload: entry.phase.payload };
		}
		return undefined;
	};

	const live = (requestId: string): R | null => {
		step(requestId, { tag: "tick" });
		const entry = pending.get(requestId);
		return entry?.phase.tag === "waiting" ? entry.request : null;
	};

	const claim = (requestId: string): { request: R; payload: P } | null => {
		if (!step(requestId, { tag: "claim" })) return null;
		const entry = pending.get(requestId);
		return entry?.phase.tag === "claimed" ? { request: entry.request, payload: entry.phase.payload } : null;
	};

	const settle = (requestId: string, answer: A): boolean => step(requestId, { tag: "answer", answer });

	const answered = (requestId: string): boolean => {
		step(requestId, { tag: "tick" });
		const phase = pending.get(requestId)?.phase;
		return phase?.tag === "claimed" || (phase?.tag === "settled" && phase.cause === "answered");
	};

	const collect = (requestId: string, sessionTarget: string): Held<R, A> | undefined => {
		step(requestId, { tag: "tick" });
		const entry = pending.get(requestId);
		if (!entry || entry.request.sessionTarget !== sessionTarget) return undefined;
		return { request: entry.request, answer: entry.answer };
	};

	const withdraw = (requestId: string, sessionTarget: string): boolean =>
		step(requestId, { tag: "withdraw", sessionTarget });

	const sessionEnded = (sessionTarget: string): void => {
		for (const [requestId, entry] of [...pending]) {
			if (entry.request.sessionTarget === sessionTarget) step(requestId, { tag: "end" });
		}
	};

	const closeWhere = (match: (request: R) => boolean, answer: A): void => {
		for (const requestId of [...pending.keys()]) {
			step(requestId, { tag: "tick" });
			const entry = pending.get(requestId);
			if (entry && match(entry.request)) step(requestId, { tag: "close", answer });
		}
	};

	const take = (requestId: string): boolean => step(requestId, { tag: "take" });

	const payloads = (): IterableIterator<P> => {
		const held: P[] = [];
		for (const requestId of [...pending.keys()]) {
			step(requestId, { tag: "tick" });
			const phase = pending.get(requestId)?.phase;
			if (phase?.tag === "waiting" || phase?.tag === "claimed") held.push(phase.payload);
		}
		return held.values();
	};

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
		take,
		withdraw,
		sessionEnded,
		closeWhere,
		payloads,
		retractStale,
	};
}

export type OwnerRequests<R extends OwnerRequestRow, A, P = undefined> = ReturnType<
	typeof createOwnerRequests<R, A, P>
>;
