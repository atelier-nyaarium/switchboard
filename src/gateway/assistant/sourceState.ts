// What a source keeps between polls, and the threads it hides.

import { z } from "zod";
import { type Decoded, type DurableStore, type RestoreRepairs, restoreHeld } from "../../shared/durable-store.js";
import type { SourceEvent } from "./source.js";

export const MAX_GONE = 256;

const SourceStateSchema = z.strictObject({
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
	/** Listed, but answered `not_found`; hidden until updated past `at`. */
	gone: z
		.array(z.strictObject({ id: z.string(), at: z.number() }))
		.max(MAX_GONE)
		.optional(),
});

export type SourceState = z.infer<typeof SourceStateSchema>;

// skew:source-unexpected
const StoredStateSchema = SourceStateSchema.extend({ unexpected: z.unknown().optional() });

/** The stored key keeps its word, so the build before sources reads it. */
const SnapshotSchema = z.strictObject({
	v: z.literal(1),
	watchers: z.record(z.string(), StoredStateSchema),
});

interface Snapshot {
	v: 1;
	watchers: Record<string, SourceState>;
}

function decodeSnapshot(raw: unknown): Decoded<Snapshot> {
	if (raw === null) return { value: { v: 1, watchers: {} }, stale: false };
	let stale = false;
	const watchers = Object.fromEntries(
		Object.entries(SnapshotSchema.parse(raw).watchers).map(([sourceId, { unexpected, ...state }]) => {
			if (unexpected !== undefined) stale = true;
			return [sourceId, state];
		}),
	);
	return { value: { v: 1, watchers }, stale };
}

export const FRESH_STATE: SourceState = { cursor: null, newest: 0, primed: false, unread: 0, capped: false };

export const isGone = (state: SourceState, event: Pick<SourceEvent, "id" | "at">): boolean =>
	state.gone?.some((entry) => entry.id === event.id && event.at <= entry.at) ?? false;

/** Newest kept at the cap. */
export function goneAdded(state: SourceState, ids: readonly string[], at: number): SourceState {
	if (ids.length === 0) return state;
	const kept = (state.gone ?? []).filter((entry) => !ids.includes(entry.id));
	const gone = [...kept, ...ids.map((id) => ({ id, at }))].slice(-MAX_GONE);
	return { ...state, gone };
}

/** A whole read drops what the source stopped listing. */
export function goneListed(state: SourceState, events: readonly SourceEvent[], capped: boolean): SourceState {
	if (capped || state.gone === undefined) return state;
	const { gone: held, ...rest } = state;
	const gone = held.filter((entry) => events.some((event) => event.id === entry.id));
	return gone.length === 0 ? rest : { ...rest, gone };
}

/** Drawn counts and health; poll ages excluded. */
const shownOf = (state: SourceState) =>
	JSON.stringify([state.unread, state.capped, state.stopped ?? null, state.backoff?.reason ?? null]);

export const shownChanged = (before: SourceState, after: SourceState): boolean => shownOf(before) !== shownOf(after);

export interface SourceStateStore {
	get(sourceId: string): SourceState;
	/** Checked; false keeps memory. */
	put(sourceId: string, next: SourceState): boolean;
}

export function createSourceStateStore(
	store: Pick<DurableStore, "load" | "saveChecked">,
	repairs: RestoreRepairs,
): SourceStateStore {
	const state = restoreHeld({ store, label: "assistant source state", decode: decodeSnapshot, repairs });
	const held = (sourceId: string) => {
		const { watchers } = state.value;
		return Object.hasOwn(watchers, sourceId) ? watchers[sourceId] : undefined;
	};
	return {
		get: (sourceId) => structuredClone(held(sourceId) ?? FRESH_STATE),
		put(sourceId, next) {
			const sources = { ...state.value.watchers };
			// A source id stays a plain key.
			Object.defineProperty(sources, sourceId, {
				value: SourceStateSchema.parse(next),
				enumerable: true,
				writable: true,
				configurable: true,
			});
			return state.commit({ v: 1, watchers: sources }).landed;
		},
	};
}
