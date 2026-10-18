// Polls each watcher on its own clock. A watcher's next poll is armed only once its last one lands.

import { type Ambient, type TimerHandle, withinMs } from "../../shared/ambient.js";
import { fireAndForget } from "../fireAndForget.js";
import type { InboxEvent, InboxStore, Sorter } from "./inboxStore.js";
import { type PollAnswer, PollAnswerSchema, WATCHER_ID_RE, type Watcher } from "./watcher.js";

/** A hung source must not hold its watcher forever. */
export const POLL_TIMEOUT_MS = 60_000;
/** After a failed poll or a write that did not land. */
export const RETRY_MS = 60_000;
/** Floor on a poll interval. */
export const MIN_POLL_MS = 10_000;
/** Shutdown waits this long; a poll still running is aborted and its answer dropped. */
const STOP_WAIT_MS = 5_000;

export interface WatcherRunnerDeps {
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	inbox: Pick<InboxStore, "commitPoll" | "stateOf">;
	watchers: readonly Watcher[];
	/** The watcher's rules, read as its poll lands. */
	rules: (watcherId: string) => Sorter;
	/** After every poll that lands, with what it accepted, once it is durable. A nudge only. */
	onLanded?: (watcherId: string, accepted: readonly InboxEvent[]) => void | Promise<void>;
}

export interface WatcherRunner {
	start(): void;
	/** Polls that watcher now, or as soon as its poll in flight lands; a stopped one included. */
	poke(watcherId: string): void;
	/** Final: arms nothing more, writes nothing a poll answers afterwards, and a start does nothing. */
	stop(): Promise<void>;
}

/** Whatever a poll did, as an answer: a throw, a hang, an abort or a malformed answer backs off. */
async function answerOf(
	watcher: Watcher,
	cursor: string | null,
	abort: AbortController,
	deps: WatcherRunnerDeps,
): Promise<PollAnswer> {
	// An abort ends the wait, so its timer goes too.
	const aborted = new Promise<PollAnswer>((resolve) => {
		const answer: PollAnswer = { kind: "backoff", retryMs: RETRY_MS, reason: "poll aborted" };
		abort.signal.addEventListener("abort", () => resolve(answer), { once: true });
	});
	try {
		const polled = Promise.race([watcher.poll(cursor, abort.signal), aborted]);
		const raw = await withinMs(deps.ambient, polled, POLL_TIMEOUT_MS);
		if (raw === null) return { kind: "backoff", retryMs: RETRY_MS, reason: "poll timed out" };
		const answer = PollAnswerSchema.safeParse(raw);
		if (!answer.success) return { kind: "backoff", retryMs: RETRY_MS, reason: "poll answered malformed data" };
		if (answer.data.kind !== "events") return answer.data;
		return { ...answer.data, nextPollMs: Math.max(MIN_POLL_MS, answer.data.nextPollMs) };
	} catch (error) {
		return { kind: "backoff", retryMs: RETRY_MS, reason: (error as Error).message };
	} finally {
		abort.abort();
	}
}

export function createWatcherRunner(deps: WatcherRunnerDeps): WatcherRunner {
	const { ambient, inbox } = deps;
	const ids = deps.watchers.map((watcher) => watcher.id);
	const bad = ids.find((id, index) => !WATCHER_ID_RE.test(id) || ids.indexOf(id) !== index);
	if (bad !== undefined) throw new Error(`watcher id "${bad}" is malformed or taken twice`);

	const timers = new Map<string, TimerHandle>();
	const flights = new Set<Promise<void>>();
	const aborts = new Set<AbortController>();
	/** Watcher ids with a poll in flight, so a poke never starts a second. */
	const polling = new Set<string>();
	const poked = new Set<string>();
	let phase: "idle" | "running" | "stopped" = "idle";

	const arm = (watcher: Watcher, at: number): void => {
		if (phase !== "running") return;
		const held = timers.get(watcher.id);
		if (held) ambient.clearTimer(held);
		const timer = ambient.setTimer(
			() => {
				timers.delete(watcher.id);
				poll(watcher);
			},
			Math.max(0, at - ambient.now()),
		);
		timers.set(watcher.id, timer);
	};

	const poll = (watcher: Watcher): void => {
		const abort = new AbortController();
		aborts.add(abort);
		polling.add(watcher.id);
		const work = async (): Promise<void> => {
			const cursor = inbox.stateOf(watcher.id, ambient.now())?.cursor ?? null;
			const answer = await answerOf(watcher, cursor, abort, deps);
			aborts.delete(abort);
			if (phase !== "running") return;
			const now = ambient.now();
			const landed = inbox.commitPoll(watcher.id, answer, now, deps.rules(watcher.id));
			if (!landed) return arm(watcher, now + RETRY_MS);
			const next = inbox.stateOf(watcher.id, now)?.nextPollAt;
			if (next !== undefined) arm(watcher, next);
			const { onLanded } = deps;
			if (!onLanded) return;
			// A throw or a rejection is logged, never left to disarm.
			const hook = Promise.resolve().then(() => onLanded(watcher.id, landed.accepted));
			fireAndForget(`assistant watcher ${watcher.id} hook`, hook);
		};
		const flight = work().finally(() => {
			flights.delete(flight);
			polling.delete(watcher.id);
			if (poked.delete(watcher.id)) arm(watcher, ambient.now());
		});
		flights.add(flight);
		fireAndForget(`watcher ${watcher.id}`, flight);
	};

	return {
		start() {
			if (phase !== "idle") return;
			phase = "running";
			// A stopped watcher gets one more try after a restart; its health says why it stopped.
			const now = ambient.now();
			for (const watcher of deps.watchers) arm(watcher, inbox.stateOf(watcher.id, now)?.nextPollAt ?? now);
		},
		poke(watcherId) {
			const watcher = deps.watchers.find((candidate) => candidate.id === watcherId);
			if (phase !== "running" || !watcher) return;
			if (polling.has(watcherId)) poked.add(watcherId);
			else arm(watcher, ambient.now());
		},
		async stop() {
			phase = "stopped";
			for (const timer of timers.values()) ambient.clearTimer(timer);
			timers.clear();
			await withinMs(ambient, Promise.allSettled([...flights]), STOP_WAIT_MS);
			for (const abort of aborts) abort.abort();
			aborts.clear();
			// Settles at once now, so no poll timer outlives the stop.
			await Promise.allSettled([...flights]);
		},
	};
}
