// One lane per watcher, so a poll cannot wake what an action cleared.

import { createHash } from "node:crypto";
import { type Ambient, type TimerHandle, withinMs } from "../../shared/ambient.js";
import type { RuleAction } from "../../shared/schemasAssistantRules.js";
import { fireAndForget } from "../fireAndForget.js";
import { type PollAnswer, PollAnswerSchema, WATCHER_ID_RE, type Watcher, type WatcherEvent } from "./watcher.js";
import type { WatcherState, WatcherStateStore } from "./watcherState.js";

/** Bounds a hung source. */
export const POLL_TIMEOUT_MS = 60_000;
/** After a failure. */
export const RETRY_MS = 60_000;
export const MIN_POLL_MS = 10_000;
/** Events per push. */
export const WAKE_BATCH = 20;
/** Per push; past it, uncommitted. */
export const WAKE_DEADLINE_MS = 90_000;
export const WAKE_RETRY_MS = 30_000;
export const WAKE_RETRY_MAX_MS = 15 * 60_000;

/** Senderless push. Null when it landed, else why not. */
export type AssistantWake = (event: {
	to: string;
	compose: () => { deliveryId: string; body: string } | null;
}) => Promise<string | null>;

export interface SourceLanesDeps {
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	state: WatcherStateStore;
	watchers: readonly Watcher[];
	/** Read as a poll lands. */
	sort: (watcherId: string, event: WatcherEvent) => RuleAction;
	/** Null until the routes are bound. */
	wake: () => AssistantWake | null;
	to: string;
	render: (watcherId: string, batch: readonly WatcherEvent[]) => string;
}

export interface SourceLanes {
	start(): void;
	/** Polls now, stopped or not. */
	poke(watcherId: string): void;
	/** Queued work; the deadline counts the queue. */
	run<T>(
		watcherId: string,
		work: (watcher: Watcher, signal: AbortSignal) => Promise<T>,
		deadlineMs: number,
	): Promise<T>;
	/** Final; fences commits. */
	stop(): Promise<void>;
}

const backedOff = (reason: string): PollAnswer => ({ kind: "backoff", retryMs: RETRY_MS, reason });

const GAVE_UP = Symbol("gave up");

/** Any failure backs off. */
async function answerOf(
	watcher: Watcher,
	cursor: string | null,
	signal: AbortSignal,
	ambient: SourceLanesDeps["ambient"],
): Promise<PollAnswer> {
	const own = new AbortController();
	const forward = () => own.abort();
	signal.addEventListener("abort", forward, { once: true });
	const aborted = new Promise<PollAnswer>((resolve) => {
		own.signal.addEventListener("abort", () => resolve(backedOff("poll aborted")), { once: true });
	});
	try {
		const polled = Promise.race([watcher.poll(cursor, own.signal), aborted]);
		const raw = await withinMs(ambient, polled, POLL_TIMEOUT_MS);
		if (raw === null) return backedOff("poll timed out");
		const answer = PollAnswerSchema.safeParse(raw);
		if (!answer.success) return backedOff("poll answered malformed data");
		if (answer.data.kind !== "events" && answer.data.kind !== "unchanged") return answer.data;
		return { ...answer.data, nextPollMs: Math.max(MIN_POLL_MS, answer.data.nextPollMs) };
	} catch (error) {
		return backedOff((error as Error).message.slice(0, 400));
	} finally {
		signal.removeEventListener("abort", forward);
		own.abort();
	}
}

const landedKey = (event: Pick<WatcherEvent, "id" | "at">) => JSON.stringify([event.id, event.at]);

/** Stable, so a retry builds the same batches. */
const oldestFirst = (a: WatcherEvent, b: WatcherEvent) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Health without standing marks. */
function cleared(held: WatcherState): WatcherState {
	const { backoff: _backoff, stopped: _stopped, nextPollAt: _next, ...kept } = held;
	return kept;
}

export function createSourceLanes(deps: SourceLanesDeps): SourceLanes {
	const { ambient, state } = deps;
	const ids = deps.watchers.map((watcher) => watcher.id);
	const bad = ids.find((id, index) => !WATCHER_ID_RE.test(id) || ids.indexOf(id) !== index);
	if (bad !== undefined) throw new Error(`watcher id "${bad}" is malformed or taken twice`);

	let phase: "idle" | "running" | "stopped" = "idle";
	const timers = new Map<string, TimerHandle>();
	const tails = new Map<string, Promise<unknown>>();
	const aborts = new Set<AbortController>();
	/** One queued poll each. */
	const queued = new Set<string>();
	/** Landed since the last commit. */
	const pushed = new Map<string, Set<string>>();
	const pushedFor = (watcherId: string) => pushed.get(watcherId) ?? new Set<string>();

	const enqueue = <T>(watcherId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
		const next = (tails.get(watcherId) ?? Promise.resolve()).then(async () => {
			if (phase === "stopped") throw new Error("the assistant is stopping");
			const abort = new AbortController();
			aborts.add(abort);
			try {
				return await work(abort.signal);
			} finally {
				aborts.delete(abort);
			}
		});
		tails.set(
			watcherId,
			next.catch(() => undefined),
		);
		return next;
	};

	const arm = (watcher: Watcher, at: number): void => {
		if (phase !== "running") return;
		const held = timers.get(watcher.id);
		if (held) ambient.clearTimer(held);
		const timer = ambient.setTimer(
			() => {
				timers.delete(watcher.id);
				schedule(watcher);
			},
			Math.max(0, at - ambient.now()),
		);
		timers.set(watcher.id, timer);
	};

	/** Fenced by stop. True once it landed. */
	const settle = (watcher: Watcher, next: WatcherState, at: number | undefined): boolean => {
		if (phase !== "running") return false;
		if (state.put(watcher.id, next)) {
			if (at !== undefined) arm(watcher, at);
			return true;
		}
		arm(watcher, Math.max(at ?? 0, ambient.now() + RETRY_MS));
		return false;
	};

	/** First failure, or null. */
	const pushAll = async (watcherId: string, wakes: readonly WatcherEvent[], signal: AbortSignal) => {
		const aborted = new Promise<{ failed: string }>((resolve) => {
			signal.addEventListener("abort", () => resolve({ failed: "the assistant is stopping" }), { once: true });
		});
		const landed = pushedFor(watcherId);
		pushed.set(watcherId, landed);
		const current = new Set(wakes.map(landedKey));
		for (const key of landed) if (!current.has(key)) landed.delete(key);
		const pending = wakes.filter((event) => !landed.has(landedKey(event)));
		for (let at = 0; at < pending.length; at += WAKE_BATCH) {
			const wake = deps.wake();
			if (!wake) return "the send path is not bound yet";
			const batch = pending.slice(at, at + WAKE_BATCH);
			const composed = { deliveryId: deliveryIdOf(watcherId, batch), body: deps.render(watcherId, batch) };
			// A push given up on composes nothing when it lands late.
			let live = true;
			const compose = () => (live && phase === "running" ? composed : null);
			const sent = wake({ to: deps.to, compose })
				.then((failed) => ({ failed }))
				.catch((error: Error) => ({ failed: error.message }));
			const answer = await Promise.race([withinMs(ambient, sent, WAKE_DEADLINE_MS), aborted]);
			if (answer === null || answer.failed) {
				live = false;
				return answer?.failed ?? "the session did not take it in time";
			}
			for (const event of batch) landed.add(landedKey(event));
		}
		return null;
	};

	/** Validator and newest commit only once every wake is queued. */
	const pollOnce = async (watcher: Watcher, signal: AbortSignal): Promise<void> => {
		const held = state.get(watcher.id);
		const answer = await answerOf(watcher, held.cursor, signal, ambient);
		if (phase !== "running") return;
		const now = ambient.now();
		const health = cleared(held);
		if (answer.kind === "backoff") {
			const until = now + answer.retryMs;
			settle(watcher, { ...health, backoff: { until, reason: answer.reason }, nextPollAt: until }, until);
			return;
		}
		if (answer.kind === "stopped") {
			settle(watcher, { ...health, stopped: answer.reason }, undefined);
			return;
		}
		if (answer.kind === "unchanged") {
			const next = now + answer.nextPollMs;
			settle(watcher, { ...health, lastSuccessAt: now, nextPollAt: next }, next);
			return;
		}
		const read = { unread: answer.events.length, capped: answer.capped, lastSuccessAt: now };
		const newest = answer.events.reduce((max, event) => Math.max(max, event.at), held.newest);
		// First poll primes without waking.
		const fresh = held.primed ? answer.events.filter((event) => event.at > held.newest) : [];
		const wakes = fresh.filter((event) => deps.sort(watcher.id, event) === "wake").sort(oldestFirst);
		const failed = await pushAll(watcher.id, wakes, signal);
		if (phase !== "running") return;
		if (failed) {
			const retry = held.wakeRetryMs ?? WAKE_RETRY_MS;
			const until = ambient.now() + retry;
			console.warn(`[assistant] ${watcher.id} wake not delivered; polling again in ${retry / 1000}s: ${failed}`);
			const kept = {
				...health,
				...read,
				backoff: { until, reason: `wake not delivered: ${failed}` },
				nextPollAt: until,
				wakeRetryMs: Math.min(retry * 2, WAKE_RETRY_MAX_MS),
			};
			settle(watcher, kept, until);
			return;
		}
		const next = now + answer.nextPollMs;
		const { wakeRetryMs: _retry, ...rest } = health;
		const advanced = { ...rest, ...read, cursor: answer.cursor, newest, primed: true, nextPollAt: next };
		if (settle(watcher, advanced, next)) pushed.delete(watcher.id);
	};

	const schedule = (watcher: Watcher): void => {
		if (phase !== "running" || queued.has(watcher.id)) return;
		queued.add(watcher.id);
		const flight = enqueue(watcher.id, (signal) => {
			queued.delete(watcher.id);
			return pollOnce(watcher, signal);
		});
		fireAndForget(`assistant watcher ${watcher.id}`, flight);
	};

	return {
		start() {
			if (phase !== "idle") return;
			phase = "running";
			// Stopped ones retry once.
			const now = ambient.now();
			for (const watcher of deps.watchers) arm(watcher, state.get(watcher.id).nextPollAt ?? now);
		},
		poke(watcherId) {
			const watcher = deps.watchers.find((candidate) => candidate.id === watcherId);
			if (phase !== "running" || !watcher) return;
			const held = timers.get(watcherId);
			if (held) ambient.clearTimer(held);
			timers.delete(watcherId);
			schedule(watcher);
		},
		async run(watcherId, work, deadlineMs) {
			const watcher = deps.watchers.find((candidate) => candidate.id === watcherId);
			if (!watcher) throw new Error(`no watcher "${watcherId}"`);
			const own = new AbortController();
			const timer = ambient.setTimer(() => own.abort(), deadlineMs);
			const gaveUp = new Promise<typeof GAVE_UP>((resolve) => {
				own.signal.addEventListener("abort", () => resolve(GAVE_UP), { once: true });
			});
			const flight = enqueue(watcherId, async (signal) => {
				if (own.signal.aborted) return GAVE_UP;
				const forward = () => own.abort();
				signal.addEventListener("abort", forward, { once: true });
				try {
					return await Promise.race([work(watcher, own.signal), gaveUp]);
				} finally {
					signal.removeEventListener("abort", forward);
				}
			});
			try {
				const answer = await Promise.race([flight, gaveUp]);
				if (answer === GAVE_UP) throw new Error(`${watcherId} did not answer in time`);
				return answer;
			} finally {
				ambient.clearTimer(timer);
				own.abort();
			}
		},
		async stop() {
			phase = "stopped";
			for (const timer of timers.values()) ambient.clearTimer(timer);
			timers.clear();
			for (const abort of aborts) abort.abort();
			await Promise.allSettled([...tails.values()]);
		},
	};
}

/** Same batch, same delivery. */
export function deliveryIdOf(watcherId: string, batch: readonly Pick<WatcherEvent, "id" | "at">[]): string {
	const hash = createHash("sha256").update(`${watcherId}\u0000`);
	for (const event of batch) hash.update(`${event.id}\u0000${event.at}\u0000`);
	return `assistant-event:${hash.digest("hex").slice(0, 32)}`;
}
