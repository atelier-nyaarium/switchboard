// What a watcher keeps between polls; no threads.

import { z } from "zod";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";

const WatcherStateSchema = z.strictObject({
	/** Sent as `If-Modified-Since`. */
	cursor: z.string().nullable(),
	/** Nothing at or before it wakes. */
	newest: z.number().int().nonnegative(),
	/** Set by the first poll. */
	primed: z.boolean(),
	/** Where the agent's `new` reads begin. */
	mark: z.number().int().nonnegative().optional(),
	/** At the last full read. */
	unread: z.number().int().nonnegative(),
	/** More unread than a poll reads. */
	capped: z.boolean(),
	lastSuccessAt: z.number().optional(),
	nextPollAt: z.number().optional(),
	backoff: z.strictObject({ until: z.number(), reason: z.string() }).optional(),
	stopped: z.string().optional(),
	/** Next wake retry wait. */
	wakeRetryMs: z.number().int().positive().optional(),
});

export type WatcherState = z.infer<typeof WatcherStateSchema>;

const SnapshotSchema = z.strictObject({
	v: z.literal(1),
	watchers: z.record(z.string(), WatcherStateSchema),
});

type Snapshot = z.infer<typeof SnapshotSchema>;

export const FRESH_STATE: WatcherState = { cursor: null, newest: 0, primed: false, unread: 0, capped: false };

export interface WatcherStateStore {
	get(watcherId: string): WatcherState;
	/** Checked; false keeps memory. */
	put(watcherId: string, next: WatcherState): boolean;
}

export function createWatcherStateStore(store: DurableStore): WatcherStateStore {
	const loaded = store.load();
	let state: Snapshot = loaded === null ? { v: 1, watchers: {} } : SnapshotSchema.parse(loaded);
	const held = (watcherId: string) =>
		Object.hasOwn(state.watchers, watcherId) ? state.watchers[watcherId] : undefined;
	return {
		get: (watcherId) => structuredClone(held(watcherId) ?? FRESH_STATE),
		put(watcherId, next) {
			const watchers = { ...state.watchers };
			// A watcher id stays a plain key.
			Object.defineProperty(watchers, watcherId, {
				value: WatcherStateSchema.parse(next),
				enumerable: true,
				writable: true,
				configurable: true,
			});
			const written: Snapshot = { v: 1, watchers };
			return commitChecked(
				store,
				written,
				(landed) => {
					state = landed;
				},
				{ label: "assistant watcher state" },
			).landed;
		},
	};
}
