// What this Gateway last learned of the Router's home record, written before anything it causes.

import { z } from "zod";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";

const StoredSchema = z.object({
	v: z.literal(1),
	/** Versions compare only within one Domain's record. */
	domainId: z.string().min(1),
	version: z.number().int().positive(),
	named: z.boolean(),
	/** Null until an apply of a choice naming this Gateway finished. */
	applied: z.enum(["placed", "refused"]).nullable(),
	reason: z.string().optional(),
});

type Stored = z.infer<typeof StoredSchema>;
export type HomeMark = Omit<Stored, "v" | "domainId">;

const markOf = ({ v: _v, domainId: _domainId, ...mark }: Stored): HomeMark => mark;

/** `domainId` is the active Domain's; a mark from another reads as none. */
export function createHomeMarkStore(store: Pick<DurableStore, "load" | "saveChecked">, domainId: () => string | null) {
	const loaded = store.load();
	let held: Stored | null = loaded === null ? null : StoredSchema.parse(loaded);
	// A newer record whose mark did not land.
	let unsettled = false;

	const get = (): HomeMark | null => (held && held.domainId === domainId() ? markOf(held) : null);

	return {
		get,
		/** False when the write did not land; the held mark is then unchanged and lanes stay shut. */
		set: (next: HomeMark): boolean => {
			const domain = domainId();
			const stored: Stored | null = domain === null ? null : { v: 1, domainId: domain, ...next };
			const landed =
				stored !== null &&
				commitChecked(
					store,
					stored,
					() => {
						held = stored;
					},
					{ label: "assistant home" },
				).landed;
			unsettled = !landed;
			return landed;
		},
		/** No mark is a Gateway before any record, which follows its own session record. */
		allowsLanes: (): boolean => {
			const mark = get();
			return !unsettled && (mark === null || (mark.named && mark.applied === "placed"));
		},
		/** A record named another, or nobody. */
		letGo: (): boolean => {
			const mark = get();
			return mark !== null && !mark.named;
		},
		/** Named, and an apply has not finished. */
		applying: (): boolean => {
			const mark = get();
			return mark?.named === true && mark.applied === null;
		},
	};
}

export type HomeMarkStore = ReturnType<typeof createHomeMarkStore>;
