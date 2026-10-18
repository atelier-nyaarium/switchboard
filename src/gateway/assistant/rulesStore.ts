// Each watcher's rules, written only by owner ops. The store names every revision.

import { z } from "zod";
import { type DurableStore, DurableStoreInstalledError } from "../../shared/durable-store.js";
import {
	type AssistantRule,
	type AssistantRuleOtherwise,
	type AssistantWatcherRules,
	AssistantWatcherRulesSchema,
	canonicalOtherwise,
	canonicalRule,
	DEFAULT_RULES,
	sameRules,
} from "../../shared/schemasAssistantRules.js";

const SnapshotSchema = z.strictObject({
	v: z.literal(1),
	watchers: z.record(z.string(), AssistantWatcherRulesSchema),
});

type Snapshot = z.infer<typeof SnapshotSchema>;

export type RulesPut =
	| { stored: true; rules: AssistantWatcherRules }
	| { stored: false; reason: string; revision: number };

export interface RulesStoreDeps {
	store: DurableStore;
	/** After the write is on disk, so a failed write sorts nothing again. */
	onChanged: (watcherId: string) => void;
}

export function createRulesStore(deps: RulesStoreDeps) {
	const loaded = deps.store.load();
	let state: Snapshot = loaded === null ? { v: 1, watchers: {} } : SnapshotSchema.parse(loaded);

	const get = (watcherId: string): AssistantWatcherRules =>
		structuredClone(
			Object.hasOwn(state.watchers, watcherId) ? (state.watchers[watcherId] ?? DEFAULT_RULES) : DEFAULT_RULES,
		);

	const commit = (next: Snapshot): boolean => {
		const previous = state;
		state = next;
		try {
			deps.store.saveChecked(state);
			return true;
		} catch (error) {
			if (error instanceof DurableStoreInstalledError) return true;
			state = previous;
			console.warn(`[assistant] rules write failed: ${(error as Error).message}`);
			return false;
		}
	};

	return {
		get,
		/** The whole list at the revision the editor read; the store writes its successor. */
		put(watcherId: string, rules: AssistantRule[], otherwise: AssistantRuleOtherwise, base: number): RulesPut {
			const held = get(watcherId);
			const asked = { rules: rules.map((rule) => canonicalRule(rule)), otherwise: canonicalOtherwise(otherwise) };
			// Lost-answer retry.
			if (base === held.revision - 1 && sameRules(asked, held)) return { stored: true, rules: held };
			if (base !== held.revision) {
				return {
					stored: false,
					reason: `revision ${held.revision} is stored; this edits ${base}`,
					revision: held.revision,
				};
			}
			const next: AssistantWatcherRules = { ...asked, revision: held.revision + 1 };
			const watchers = { ...state.watchers };
			Object.defineProperty(watchers, watcherId, {
				value: next,
				enumerable: true,
				writable: true,
				configurable: true,
			});
			if (!commit({ v: 1, watchers })) {
				return { stored: false, reason: "the rules could not be saved", revision: held.revision };
			}
			try {
				deps.onChanged(watcherId);
			} catch (error) {
				// Landed; the next start sorts again.
				console.warn(`[assistant] rules hook failed: ${(error as Error).message}`);
			}
			return { stored: true, rules: structuredClone(next) };
		},
	};
}

export type RulesStore = ReturnType<typeof createRulesStore>;
