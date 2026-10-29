// What this Gateway last learned of the Router's home record, written before anything it causes.

import { z } from "zod";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";

const StoredSchema = z.object({
	v: z.literal(1),
	version: z.number().int().positive(),
	named: z.boolean(),
	/** Null until an apply of a choice naming this Gateway finished. */
	applied: z.enum(["placed", "refused"]).nullable(),
	reason: z.string().optional(),
});

export type HomeMark = Omit<z.infer<typeof StoredSchema>, "v">;

const markOf = ({ v: _v, ...mark }: z.infer<typeof StoredSchema>): HomeMark => mark;

export function createHomeMarkStore(store: Pick<DurableStore, "load" | "saveChecked">) {
	const loaded = store.load();
	let mark: HomeMark | null = loaded === null ? null : markOf(StoredSchema.parse(loaded));
	// A newer record whose mark did not land.
	let unsettled = false;

	return {
		get: (): HomeMark | null => mark,
		/** False when the write did not land; the held mark is then unchanged and lanes stay shut. */
		set: (next: HomeMark): boolean => {
			const landed = commitChecked(
				store,
				{ v: 1, ...next },
				() => {
					mark = next;
				},
				{ label: "assistant home" },
			).landed;
			unsettled = !landed;
			return landed;
		},
		/** No mark is a Gateway before any record, which follows its own session record. */
		allowsLanes: (): boolean => !unsettled && (mark === null || (mark.named && mark.applied === "placed")),
		/** A record named another, or nobody. */
		letGo: (): boolean => mark !== null && !mark.named,
		/** Named, and an apply has not finished. */
		applying: (): boolean => mark !== null && mark.named && mark.applied === null,
	};
}

export type HomeMarkStore = ReturnType<typeof createHomeMarkStore>;
