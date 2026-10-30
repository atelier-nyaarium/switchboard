// One lane per watcher, so a poll cannot wake what an action cleared. The lane owns every deadline.

import { type Ambient, type Linked, linkedSignal, type TimerHandle } from "../../shared/ambient.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import type { EventMember } from "../../shared/pending-delivery-store.js";
import type { RuleAction } from "../../shared/schemasAssistantRules.js";
import { fireAndForget } from "../fireAndForget.js";
import { type PollAnswer, PollAnswerSchema, WATCHER_ID_RE, type Watcher, type WatcherEvent } from "./watcher.js";
import { unexpectedAfter, unexpectedNow, type WatcherState, type WatcherStateStore } from "./watcherState.js";

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
	compose: () => readonly EventMember[] | null;
}) => Promise<string | null>;

export interface SourceLanesDeps {
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	state: WatcherStateStore;
	watchers: readonly Watcher[];
	/** Disabled polls nothing. */
	enabled: (watcherId: string) => boolean;
	/** Read as a poll lands. */
	sort: (watcherId: string, event: WatcherEvent) => RuleAction;
	/** Null until the routes are bound. */
	wake: () => AssistantWake | null;
	to: string;
	render: (watcher: Watcher, event: WatcherEvent) => string;
}

/** Why the lane ended a signal. */
export type LaneEnd = "past_deadline" | "stopping";

export type WriteAnswer<T> = { kind: "ran"; value: T } | { kind: "not_started"; end: LaneEnd };
export type ReadAnswer<T> = WriteAnswer<T> | { kind: "gave_up"; end: LaneEnd };

export interface SourceLanes {
	start(): void;
	/** Polls now, stopped or not; a disabled one drops its timer. */
	poke(watcherId: string): void;
	/** Turned on or off: a poll in flight commits and wakes nothing, then as `poke`. */
	switched(watcherId: string): void;
	/** Next poll reads whole. */
	recount(watcherId: string): void;
	/** Released at the deadline; `settle` runs only while the read is live. */
	read<L, T>(
		watcherId: string,
		deadlineMs: number,
		load: (watcher: Watcher, signal: AbortSignal) => Promise<L>,
		settle: (loaded: L) => T,
	): Promise<ReadAnswer<T>>;
	/** Held until `work` settles; its signal ends at the deadline. */
	write<T>(watcherId: string, deadlineMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<WriteAnswer<T>>;
	/** Final; fences commits. */
	stop(): Promise<void>;
}

class LaneEndReason extends Error {
	constructor(readonly end: LaneEnd) {
		super(end === "stopping" ? "the assistant is stopping" : "past the deadline");
	}
}

const PAST_DEADLINE = new LaneEndReason("past_deadline");
const STOPPING = new LaneEndReason("stopping");

/** Why the lane ended this signal, or one linked to it, or null. */
export function laneEnd(signal: AbortSignal): LaneEnd | null {
	return signal.aborted && signal.reason instanceof LaneEndReason ? signal.reason.end : null;
}

const backedOff = (reason: string): PollAnswer => ({ kind: "backoff", retryMs: RETRY_MS, reason });

const CUT = Symbol("cut");
const SETTLED = Symbol("settled");

/** Any failure backs off. */
async function answerOf(
	watcher: Watcher,
	cursor: string | null,
	signal: AbortSignal,
	ambient: SourceLanesDeps["ambient"],
): Promise<PollAnswer> {
	const bound = linkedSignal(ambient, { parent: signal, ms: POLL_TIMEOUT_MS, reason: CUT });
	const cut = bound.ended.then((reason) => backedOff(reason === CUT ? "poll timed out" : "poll aborted"));
	try {
		const polled = await Promise.race([watcher.poll(cursor, bound.signal).then((raw) => ({ raw })), cut]);
		if (!("raw" in polled)) return polled;
		const answer = PollAnswerSchema.safeParse(polled.raw);
		if (!answer.success) return backedOff("poll answered malformed data");
		if (answer.data.kind !== "events" && answer.data.kind !== "unchanged") return answer.data;
		return { ...answer.data, nextPollMs: Math.max(MIN_POLL_MS, answer.data.nextPollMs) };
	} catch (error) {
		return backedOff((error as Error).message.slice(0, 400));
	} finally {
		bound.end(SETTLED);
	}
}

/** New activity is a new member. */
const memberKey = (watcherId: string, event: Pick<WatcherEvent, "id" | "at">) =>
	JSON.stringify([watcherId, event.id, event.at]);

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
	const unnamed = deps.watchers.find((watcher) => watcher.label.trim() === "");
	if (unnamed) throw new Error(`watcher "${unnamed.id}" has no label`);

	let phase: "idle" | "running" | "stopped" = "idle";
	const timers = new Map<string, TimerHandle>();
	const lanes = createKeyedFifo<string>();
	/** Every queued or running item, so stop ends each at once. */
	const items = new Set<Linked>();
	/** One queued poll each. */
	const pollQueued = new Set<string>();
	/** Until a whole read lands. */
	const recounts = new Set<string>();
	/** Bumped by `switched`. */
	const generations = new Map<string, number>();
	const generationOf = (watcherId: string) => generations.get(watcherId) ?? 0;

	/**
	 * The one road into a lane. An item's deadline counts the queue: one not started by then answers
	 * `not_started` and later runs nothing. A started `release` item frees the lane at the deadline; a
	 * `hold` item keeps it until it settles, and its signal says the deadline passed.
	 */
	const queued = <T>(
		watcherId: string,
		bound: { ms: number; atDeadline: "release" | "hold" } | null,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<ReadAnswer<T>> => {
		const item = linkedSignal(ambient, bound ? { ms: bound.ms, reason: PAST_DEADLINE } : {});
		if (phase === "stopped") item.end(STOPPING);
		items.add(item);
		let started = false;
		const turn = lanes.run(watcherId, async (): Promise<ReadAnswer<T>> => {
			try {
				const ended = laneEnd(item.signal);
				if (ended) return { kind: "not_started", end: ended };
				started = true;
				const ran = work(item.signal).then((value): ReadAnswer<T> => ({ kind: "ran", value }));
				if (bound?.atDeadline !== "release") return await ran;
				// Released work answers no one.
				ran.catch(() => undefined);
				const released = item.ended.then(
					(): ReadAnswer<T> => ({ kind: "gave_up", end: laneEnd(item.signal) ?? "past_deadline" }),
				);
				return await Promise.race([ran, released]);
			} finally {
				items.delete(item);
				item.dispose();
			}
		});
		const unstarted = item.ended.then(
			(): Promise<ReadAnswer<T>> =>
				started
					? new Promise(() => {})
					: Promise.resolve({ kind: "not_started", end: laneEnd(item.signal) ?? "stopping" }),
		);
		return Promise.race([turn, unstarted]);
	};

	const arm = (watcher: Watcher, at: number): void => {
		if (phase !== "running") return;
		const held = timers.get(watcher.id);
		if (held) ambient.clearTimer(held);
		timers.delete(watcher.id);
		if (!deps.enabled(watcher.id)) return;
		const timer = ambient.setTimer(
			() => {
				timers.delete(watcher.id);
				schedule(watcher);
			},
			Math.max(0, at - ambient.now()),
		);
		timers.set(watcher.id, timer);
	};

	/** Fenced by stop; true once landed. */
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
	const pushAll = async (watcher: Watcher, wakes: readonly WatcherEvent[], signal: AbortSignal) => {
		for (let at = 0; at < wakes.length; at += WAKE_BATCH) {
			const wake = deps.wake();
			if (!wake) return "the send path is not bound yet";
			const members = wakes
				.slice(at, at + WAKE_BATCH)
				.map((event) => ({ key: memberKey(watcher.id, event), text: deps.render(watcher, event) }));
			const batch = linkedSignal(ambient, { parent: signal, ms: WAKE_DEADLINE_MS, reason: CUT });
			// A push given up on composes nothing when it lands late.
			const compose = () => (!batch.signal.aborted && phase === "running" ? members : null);
			const sent = wake({ to: deps.to, compose }).then(
				(failed) => ({ failed }),
				(error: Error) => ({ failed: error.message }),
			);
			const cut = batch.ended.then((reason) => ({
				failed: reason === CUT ? "the session did not take it in time" : "the assistant is stopping",
			}));
			const answer = await Promise.race([sent, cut]);
			if (answer.failed) {
				batch.end(SETTLED);
				return answer.failed;
			}
			batch.dispose();
		}
		return null;
	};

	/** Validator and newest commit only once every wake is queued. */
	const pollOnce = async (watcher: Watcher, signal: AbortSignal): Promise<void> => {
		const began = generationOf(watcher.id);
		const live = () => phase === "running" && deps.enabled(watcher.id) && generationOf(watcher.id) === began;
		if (!live()) return;
		const held = state.get(watcher.id);
		const whole = recounts.has(watcher.id);
		const answer = await answerOf(watcher, whole ? null : held.cursor, signal, ambient);
		if (!live()) return;
		const now = ambient.now();
		// Every settle writes the set pruned against the current specs.
		const health = { ...cleared(held), unexpected: unexpectedNow(held, watcher.fieldSpecs) };
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
		// Record all event values before freshness filtering.
		const unexpected = unexpectedAfter(held.unexpected, answer.events, watcher.fieldSpecs);
		const read = { unread: answer.events.length, capped: answer.capped, lastSuccessAt: now, unexpected };
		const newest = answer.events.reduce((max, event) => Math.max(max, event.at), held.newest);
		// First poll primes without waking.
		const fresh = held.primed ? answer.events.filter((event) => event.at > held.newest) : [];
		const wakes = fresh.filter((event) => deps.sort(watcher.id, event) === "wake").sort(oldestFirst);
		const failed = await pushAll(watcher, wakes, signal);
		if (!live()) return;
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
		if (settle(watcher, advanced, next) && whole) recounts.delete(watcher.id);
	};

	const schedule = (watcher: Watcher): void => {
		if (phase !== "running" || pollQueued.has(watcher.id) || !deps.enabled(watcher.id)) return;
		pollQueued.add(watcher.id);
		const flight = queued(watcher.id, null, (signal) => {
			pollQueued.delete(watcher.id);
			return pollOnce(watcher, signal);
		});
		fireAndForget(`assistant watcher ${watcher.id}`, flight);
	};

	const poke = (watcherId: string): void => {
		const watcher = deps.watchers.find((candidate) => candidate.id === watcherId);
		if (phase !== "running" || !watcher) return;
		const held = timers.get(watcherId);
		if (held) ambient.clearTimer(held);
		timers.delete(watcherId);
		schedule(watcher);
	};

	const watcherOf = (watcherId: string): Watcher => {
		const watcher = deps.watchers.find((candidate) => candidate.id === watcherId);
		if (!watcher) throw new Error(`no watcher "${watcherId}"`);
		return watcher;
	};

	return {
		start() {
			if (phase !== "idle") return;
			phase = "running";
			// Stopped ones retry once.
			const now = ambient.now();
			for (const watcher of deps.watchers) arm(watcher, state.get(watcher.id).nextPollAt ?? now);
		},
		poke,
		switched(watcherId) {
			generations.set(watcherId, generationOf(watcherId) + 1);
			poke(watcherId);
		},
		recount(watcherId) {
			if (phase !== "running" || !deps.watchers.some((watcher) => watcher.id === watcherId)) return;
			recounts.add(watcherId);
			poke(watcherId);
		},
		async read(watcherId, deadlineMs, load, settle) {
			const watcher = watcherOf(watcherId);
			return queued(watcherId, { ms: deadlineMs, atDeadline: "release" }, async (signal) => {
				const loaded = await load(watcher, signal);
				// Given up on, so it commits nothing.
				if (signal.aborted) throw new Error("the read was given up");
				return settle(loaded);
			});
		},
		async write(watcherId, deadlineMs, work) {
			watcherOf(watcherId);
			// A held item never answers `gave_up`.
			return queued(watcherId, { ms: deadlineMs, atDeadline: "hold" }, work) as Promise<
				WriteAnswer<Awaited<ReturnType<typeof work>>>
			>;
		},
		async stop() {
			phase = "stopped";
			for (const timer of timers.values()) ambient.clearTimer(timer);
			timers.clear();
			for (const item of items) item.end(STOPPING);
			await lanes.drain();
		},
	};
}
