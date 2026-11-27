// One lane per source, so a poll cannot wake what an action cleared. The lane owns every deadline.

import { type Ambient, type Linked, linkedSignal, type TimerHandle } from "../../shared/ambient.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import type { EventMember } from "../../shared/pending-delivery-store.js";
import type { RuleAction } from "../../shared/schemasAssistantRules.js";
import { fireAndForget } from "../fireAndForget.js";
import { type PollAnswer, PollAnswerSchema, SOURCE_ID_RE, type Source, type SourceEvent } from "./source.js";
import { goneListed, isGone, type SourceState, type SourceStateStore, shownChanged } from "./sourceState.js";

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
/** A wake's answer while the session is working, at its limit or prompted. */
export const WAKE_BUSY = "the assistant is busy";

/** Senderless push. Null when it landed, else why not. */
export type AssistantWake = (event: {
	to: string;
	compose: () => readonly EventMember[] | null;
}) => Promise<string | null>;

export interface SourceLanesDeps {
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	state: SourceStateStore;
	sources: readonly Source[];
	/** Disabled polls nothing. */
	enabled: (sourceId: string) => boolean;
	/** Read on commit. */
	sort: (sourceId: string, event: SourceEvent) => RuleAction;
	/** Null until bound. */
	wake: () => AssistantWake | null;
	to: string;
	holdLine: () => string;
	render: (source: Source, event: SourceEvent) => string;
	/** After a landed settle the phone would draw differently. */
	changed: (sourceId: string) => void;
	/** Committed wakes. */
	woke?: (sourceId: string, events: readonly SourceEvent[]) => void;
	/** Fresh events, once their poll committed. */
	arrived?: (sourceId: string, events: readonly SourceEvent[]) => void;
}

export type LaneEnd = "past_deadline" | "stopping";

export type WriteAnswer<T> = { kind: "ran"; value: T } | { kind: "not_started"; end: LaneEnd };
export type ReadAnswer<T> = WriteAnswer<T> | { kind: "gave_up"; end: LaneEnd };

export interface SourceLanes {
	start(): void;
	/** Polls now, stopped or not; a disabled one drops its timer. */
	poke(sourceId: string): void;
	/** Turned on or off: a poll in flight commits and wakes nothing, then as `poke`. */
	switched(sourceId: string): void;
	/** Next poll reads whole. */
	recount(sourceId: string): void;
	/** Released at the deadline; `settle` runs only while the read is live. */
	read<L, T>(
		sourceId: string,
		deadlineMs: number,
		load: (source: Source, signal: AbortSignal) => Promise<L>,
		settle: (loaded: L) => T,
	): Promise<ReadAnswer<T>>;
	/** Held until `work` settles; its signal ends at the deadline. */
	write<T>(sourceId: string, deadlineMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<WriteAnswer<T>>;
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
	source: Source,
	cursor: string | null,
	signal: AbortSignal,
	ambient: SourceLanesDeps["ambient"],
): Promise<PollAnswer> {
	const bound = linkedSignal(ambient, { parent: signal, ms: POLL_TIMEOUT_MS, reason: CUT });
	const cut = bound.ended.then((reason) => backedOff(reason === CUT ? "poll timed out" : "poll aborted"));
	try {
		const polled = await Promise.race([source.poll(cursor, bound.signal).then((raw) => ({ raw })), cut]);
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
export const memberKey = (sourceId: string, event: Pick<SourceEvent, "id" | "at">) =>
	JSON.stringify([sourceId, event.id, event.at]);

/** Stable, so a retry builds the same batches. */
const oldestFirst = (a: SourceEvent, b: SourceEvent) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Health without standing marks. */
function cleared(held: SourceState): SourceState {
	const { backoff: _backoff, stopped: _stopped, nextPollAt: _next, ...kept } = held;
	return kept;
}

export function createSourceLanes(deps: SourceLanesDeps): SourceLanes {
	const { ambient, state } = deps;
	const ids = deps.sources.map((source) => source.id);
	const bad = ids.find((id, index) => !SOURCE_ID_RE.test(id) || ids.indexOf(id) !== index);
	if (bad !== undefined) throw new Error(`source id "${bad}" is malformed or taken twice`);
	const unnamed = deps.sources.find((source) => source.label.trim() === "");
	if (unnamed) throw new Error(`source "${unnamed.id}" has no label`);

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
	const generationOf = (sourceId: string) => generations.get(sourceId) ?? 0;

	/**
	 * The one road into a lane. An item's deadline counts the queue: one not started by then answers
	 * `not_started` and later runs nothing. A started `release` item frees the lane at the deadline; a
	 * `hold` item keeps it until it settles, and its signal says the deadline passed.
	 */
	const queued = <T>(
		sourceId: string,
		bound: { ms: number; atDeadline: "release" | "hold" } | null,
		work: (signal: AbortSignal) => Promise<T>,
	): Promise<ReadAnswer<T>> => {
		const item = linkedSignal(ambient, bound ? { ms: bound.ms, reason: PAST_DEADLINE } : {});
		if (phase === "stopped") item.end(STOPPING);
		items.add(item);
		let started = false;
		const turn = lanes.run(sourceId, async (): Promise<ReadAnswer<T>> => {
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

	const arm = (source: Source, at: number): void => {
		if (phase !== "running") return;
		const held = timers.get(source.id);
		if (held) ambient.clearTimer(held);
		timers.delete(source.id);
		if (!deps.enabled(source.id)) return;
		const timer = ambient.setTimer(
			() => {
				timers.delete(source.id);
				schedule(source);
			},
			Math.max(0, at - ambient.now()),
		);
		timers.set(source.id, timer);
	};

	/** Fenced by stop; true once landed. */
	const settle = (source: Source, next: SourceState, at: number | undefined): boolean => {
		if (phase !== "running") return false;
		const before = state.get(source.id);
		if (state.put(source.id, next)) {
			if (at !== undefined) arm(source, at);
			if (shownChanged(before, next)) deps.changed(source.id);
			return true;
		}
		arm(source, Math.max(at ?? 0, ambient.now() + RETRY_MS));
		return false;
	};

	/** First failure, or null. */
	const pushAll = async (source: Source, wakes: readonly SourceEvent[], signal: AbortSignal) => {
		for (let at = 0; at < wakes.length; at += WAKE_BATCH) {
			const wake = deps.wake();
			if (!wake) return "the send path is not bound yet";
			const members = wakes
				.slice(at, at + WAKE_BATCH)
				.map((event) => ({ key: memberKey(source.id, event), text: deps.render(source, event) }));
			const batch = linkedSignal(ambient, { parent: signal, ms: WAKE_DEADLINE_MS, reason: CUT });
			const compose = () => {
				if (batch.signal.aborted || phase !== "running") return null;
				const line = deps.holdLine();
				const [first, ...rest] = members;
				if (!line || !first) return members;
				return [{ ...first, text: `${line}\n${first.text}` }, ...rest];
			};
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
	const pollOnce = async (source: Source, signal: AbortSignal): Promise<void> => {
		const began = generationOf(source.id);
		const live = () => phase === "running" && deps.enabled(source.id) && generationOf(source.id) === began;
		if (!live()) return;
		const held = state.get(source.id);
		const whole = recounts.has(source.id);
		const answer = await answerOf(source, whole ? null : held.cursor, signal, ambient);
		if (!live()) return;
		const now = ambient.now();
		const health = cleared(held);
		if (answer.kind === "backoff") {
			const until = now + answer.retryMs;
			settle(source, { ...health, backoff: { until, reason: answer.reason }, nextPollAt: until }, until);
			return;
		}
		if (answer.kind === "stopped") {
			settle(source, { ...health, stopped: answer.reason }, undefined);
			return;
		}
		if (answer.kind === "unchanged") {
			const next = now + answer.nextPollMs;
			settle(source, { ...health, lastSuccessAt: now, nextPollAt: next }, next);
			return;
		}
		const pruned = goneListed(health, answer.events, answer.capped);
		const shown = answer.events.filter((event) => !isGone(pruned, event));
		const read = { unread: shown.length, capped: answer.capped, lastSuccessAt: now };
		const newest = answer.events.reduce((max, event) => Math.max(max, event.at), held.newest);
		// First poll primes without waking.
		const fresh = held.primed ? shown.filter((event) => event.at > held.newest) : [];
		const wakes = fresh.filter((event) => deps.sort(source.id, event) === "wake").sort(oldestFirst);
		const failed = await pushAll(source, wakes, signal);
		if (!live()) return;
		if (failed) {
			// A busy session is not a failing one, so it does not back off further.
			const busy = failed === WAKE_BUSY;
			const retry = busy ? WAKE_RETRY_MS : (held.wakeRetryMs ?? WAKE_RETRY_MS);
			const until = ambient.now() + retry;
			console.warn(`[assistant] ${source.id} wake not delivered; polling again in ${retry / 1000}s: ${failed}`);
			const kept = {
				...pruned,
				...read,
				backoff: { until, reason: `wake not delivered: ${failed}` },
				nextPollAt: until,
				...(busy ? {} : { wakeRetryMs: Math.min(retry * 2, WAKE_RETRY_MAX_MS) }),
			};
			settle(source, kept, until);
			return;
		}
		const next = now + answer.nextPollMs;
		const { wakeRetryMs: _retry, ...rest } = pruned;
		const advanced = { ...rest, ...read, cursor: answer.cursor, newest, primed: true, nextPollAt: next };
		if (!settle(source, advanced, next)) return;
		if (whole) recounts.delete(source.id);
		if (wakes.length > 0) deps.woke?.(source.id, wakes);
		if (fresh.length > 0) deps.arrived?.(source.id, fresh);
	};

	const schedule = (source: Source): void => {
		if (phase !== "running" || pollQueued.has(source.id) || !deps.enabled(source.id)) return;
		pollQueued.add(source.id);
		const flight = queued(source.id, null, (signal) => {
			pollQueued.delete(source.id);
			return pollOnce(source, signal);
		});
		fireAndForget(`assistant source ${source.id}`, flight);
	};

	const poke = (sourceId: string): void => {
		const source = deps.sources.find((candidate) => candidate.id === sourceId);
		if (phase !== "running" || !source) return;
		const held = timers.get(sourceId);
		if (held) ambient.clearTimer(held);
		timers.delete(sourceId);
		schedule(source);
	};

	const sourceOf = (sourceId: string): Source => {
		const source = deps.sources.find((candidate) => candidate.id === sourceId);
		if (!source) throw new Error(`no source "${sourceId}"`);
		return source;
	};

	return {
		start() {
			if (phase !== "idle") return;
			phase = "running";
			// Stopped ones retry once.
			const now = ambient.now();
			for (const source of deps.sources) arm(source, state.get(source.id).nextPollAt ?? now);
		},
		poke,
		switched(sourceId) {
			generations.set(sourceId, generationOf(sourceId) + 1);
			poke(sourceId);
		},
		recount(sourceId) {
			if (phase !== "running" || !deps.sources.some((source) => source.id === sourceId)) return;
			recounts.add(sourceId);
			poke(sourceId);
		},
		async read(sourceId, deadlineMs, load, settle) {
			const source = sourceOf(sourceId);
			return queued(sourceId, { ms: deadlineMs, atDeadline: "release" }, async (signal) => {
				const loaded = await load(source, signal);
				// Given up on, so it commits nothing.
				if (signal.aborted) throw new Error("the read was given up");
				return settle(loaded);
			});
		},
		async write(sourceId, deadlineMs, work) {
			sourceOf(sourceId);
			// A held item never answers `gave_up`.
			return queued(sourceId, { ms: deadlineMs, atDeadline: "hold" }, work) as Promise<
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
