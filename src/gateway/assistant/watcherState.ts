// What a watcher keeps between polls; no threads.

import { z } from "zod";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import type { AssistantFieldSpec, AssistantFieldValue } from "../../shared/schemasAssistantRules.js";
import type { WatcherEvent } from "./watcher.js";

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
	/** Undeclared enumeration values. */
	unexpected: z
		.strictObject({
			values: z.array(z.strictObject({ field: z.string(), value: z.string() })),
			capped: z.boolean(),
		})
		.optional(),
});

export type WatcherState = z.infer<typeof WatcherStateSchema>;

const SnapshotSchema = z.strictObject({
	v: z.literal(1),
	watchers: z.record(z.string(), WatcherStateSchema),
});

type Snapshot = z.infer<typeof SnapshotSchema>;

export const FRESH_STATE: WatcherState = { cursor: null, newest: 0, primed: false, unread: 0, capped: false };

export const MAX_UNEXPECTED = 32;

type Unexpected = NonNullable<WatcherState["unexpected"]>;

const keyOf = (entry: AssistantFieldValue) => JSON.stringify([entry.field, entry.value]);

/** Undeclared enum values. */
const stillUnexpected = (specs: readonly AssistantFieldSpec[], entry: AssistantFieldValue) =>
	specs.some(
		(spec) =>
			spec.kind === "enumeration" &&
			spec.field === entry.field &&
			!spec.options.some((option) => option.value === entry.value),
	);

/** Prune listed values, add observed values; ignore missing fields. */
export function unexpectedAfter(
	held: Unexpected | undefined,
	events: readonly WatcherEvent[],
	specs: readonly AssistantFieldSpec[],
): Unexpected | undefined {
	const values = (held?.values ?? []).filter((entry) => stillUnexpected(specs, entry));
	const seen = new Set(values.map(keyOf));
	let capped = held?.capped ?? false;
	for (const event of events) {
		for (const spec of specs) {
			if (spec.kind !== "enumeration" || !Object.hasOwn(event.fields, spec.field)) continue;
			const entry = { field: spec.field, value: event.fields[spec.field] ?? "" };
			// No list can name a blank, so it is never reported.
			if (entry.value.trim() === "") continue;
			if (!stillUnexpected(specs, entry) || seen.has(keyOf(entry))) continue;
			if (values.length >= MAX_UNEXPECTED) {
				capped = true;
				continue;
			}
			seen.add(keyOf(entry));
			values.push(entry);
		}
	}
	return values.length === 0 && !capped ? undefined : { values, capped };
}

/** Pruned against active specs. */
export const unexpectedNow = (state: WatcherState, specs: readonly AssistantFieldSpec[]) =>
	unexpectedAfter(state.unexpected, [], specs);

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
