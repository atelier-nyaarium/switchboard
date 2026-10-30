// Which watchers are off. Absent is on.

import { z } from "zod";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";

const SnapshotSchema = z.strictObject({ v: z.literal(1), off: z.array(z.string()) });

export interface WatcherEnabledStore {
	enabled(watcherId: string): boolean;
	/** Checked; false keeps memory. */
	set(watcherId: string, enabled: boolean): boolean;
	/** The whole off set. */
	replaceOff(watcherIds: readonly string[]): boolean;
}

export function createWatcherEnabledStore(store: Pick<DurableStore, "load" | "saveChecked">): WatcherEnabledStore {
	const loaded = store.load();
	let off = new Set(loaded === null ? [] : SnapshotSchema.parse(loaded).off);
	const write = (next: Set<string>) =>
		commitChecked(
			store,
			{ v: 1, off: [...next] },
			() => {
				off = next;
			},
			{ label: "assistant watcher enabled" },
		).landed;
	return {
		enabled: (watcherId) => !off.has(watcherId),
		set(watcherId, enabled) {
			const next = new Set(off);
			if (enabled) next.delete(watcherId);
			else next.add(watcherId);
			return write(next);
		},
		replaceOff: (watcherIds) => write(new Set(watcherIds)),
	};
}
