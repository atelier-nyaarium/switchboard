// Which sources are off. Absent is on.

import { z } from "zod";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";

const SnapshotSchema = z.strictObject({ v: z.literal(1), off: z.array(z.string()) });

export interface SourceEnabledStore {
	enabled(sourceId: string): boolean;
	/** Checked; false keeps memory. */
	set(sourceId: string, enabled: boolean): boolean;
	/** The whole off set. */
	replaceOff(sourceIds: readonly string[]): boolean;
}

export function createSourceEnabledStore(store: Pick<DurableStore, "load" | "saveChecked">): SourceEnabledStore {
	const loaded = store.load();
	let off = new Set(loaded === null ? [] : SnapshotSchema.parse(loaded).off);
	const write = (next: Set<string>) =>
		commitChecked(
			store,
			{ v: 1, off: [...next] },
			() => {
				off = next;
			},
			{ label: "assistant source enabled" },
		).landed;
	return {
		enabled: (sourceId) => !off.has(sourceId),
		set(sourceId, enabled) {
			const next = new Set(off);
			if (enabled) next.delete(sourceId);
			else next.add(sourceId);
			return write(next);
		},
		replaceOff: (sourceIds) => write(new Set(sourceIds)),
	};
}
