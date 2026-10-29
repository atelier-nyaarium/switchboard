// Each watcher's rules, written only by owner ops. The store names every revision.

import { z } from "zod";
import { capFifo } from "../../shared/cap-fifo.js";
import { commitChecked, type DurableStore } from "../../shared/durable-store.js";
import {
	type AssistantFieldSpec,
	type AssistantRule,
	AssistantRuleConditionSchema,
	type AssistantRuleOtherwise,
	AssistantRuleOtherwiseSchema,
	AssistantRuleSchema,
	type AssistantWatcherRules,
	AssistantWatcherRulesSchema,
	type ConsoleAssistantRulesResult,
	canonicalRule,
	DEFAULT_RULES,
	invalidRules,
	parseRuleForFields,
	sameContent,
} from "../../shared/schemasAssistantRules.js";
import { ASSISTANT_RULE_CONDITIONS_MAX, ASSISTANT_RULES_MAX } from "../../shared/wire-vocabulary.js";

// Strict on disk only; the console input stays tolerant.
const StoredRuleSchema = z.strictObject({
	...AssistantRuleSchema.shape,
	conditions: z.array(z.strictObject(AssistantRuleConditionSchema.shape)).min(1).max(ASSISTANT_RULE_CONDITIONS_MAX),
});

const StoredRulesSchema = z.strictObject({
	...AssistantWatcherRulesSchema.shape,
	rules: z.array(StoredRuleSchema).max(ASSISTANT_RULES_MAX),
	otherwise: z.strictObject(AssistantRuleOtherwiseSchema.shape),
});

const SnapshotSchema = z.strictObject({
	v: z.literal(1),
	watchers: z.record(z.string(), StoredRulesSchema),
});

type Snapshot = z.infer<typeof SnapshotSchema>;

const EMPTY: Snapshot = { v: 1, watchers: {} };

/** Bounds the buried set. */
const MAX_BURIED = 256;

export interface RulesStoreDeps {
	store: DurableStore;
	/** Undefined when watcher absent. */
	specsOf: (watcherId: string) => readonly AssistantFieldSpec[] | undefined;
}

type Loose = Record<string, unknown>;

const isLoose = (value: unknown): value is Loose => typeof value === "object" && value !== null;

function withoutPing(rule: Loose): Loose {
	const { ping: _ping, ...kept } = rule;
	return kept;
}

/** Older files, before the parse refuses them. A changed list moves its revision. */
function decodedLegacy(raw: unknown): unknown {
	if (!isLoose(raw) || !isLoose(raw.watchers)) return raw;
	// Watcher ids stay plain keys.
	const watchers: Loose = Object.create(null);
	for (const [watcherId, held] of Object.entries(raw.watchers)) {
		if (!isLoose(held) || !Array.isArray(held.rules) || !isLoose(held.otherwise)) {
			watchers[watcherId] = held;
			continue;
		}
		const rules = held.rules.filter((rule) => !isLoose(rule) || rule.action !== "drop");
		const kept = rules.map((rule) => (isLoose(rule) ? withoutPing(rule) : rule));
		const otherwise = withoutPing({
			...held.otherwise,
			...(held.otherwise.action === "drop" ? { action: "inbox" } : {}),
		});
		const changed = JSON.stringify([kept, otherwise]) !== JSON.stringify([held.rules, held.otherwise]);
		const revision = typeof held.revision === "number" && changed ? held.revision + 1 : held.revision;
		watchers[watcherId] = { ...held, rules: kept, otherwise, revision };
	}
	return { ...raw, watchers };
}

/** Duplicate IDs start fresh; spec-invalid rules remain held. */
function restored(snapshot: Snapshot): Snapshot {
	for (const [watcherId, held] of Object.entries(snapshot.watchers)) {
		const ids = held.rules.map((rule) => rule.id);
		if (new Set(ids).size !== ids.length) {
			console.warn(`[assistant] ${watcherId} rules name one id twice; starting fresh`);
			return EMPTY;
		}
	}
	return snapshot;
}

export function createRulesStore(deps: RulesStoreDeps) {
	const loaded = deps.store.load();
	let state: Snapshot = loaded === null ? EMPTY : restored(SnapshotSchema.parse(decodedLegacy(loaded)));
	// Blocks a retried create of a deleted id.
	const buried = new Map<string, number>();
	const graveOf = (watcherId: string, ruleId: string) => `${watcherId}/${ruleId}`;

	const get = (watcherId: string): AssistantWatcherRules =>
		structuredClone(
			Object.hasOwn(state.watchers, watcherId) ? (state.watchers[watcherId] ?? DEFAULT_RULES) : DEFAULT_RULES,
		);

	const commit = (next: Snapshot): boolean =>
		commitChecked(
			deps.store,
			next,
			(landed) => {
				state = landed;
			},
			{ label: "assistant rules" },
		).landed;

	const answer = (watcherId: string, stored: boolean, reason?: string): ConsoleAssistantRulesResult => {
		const rules = get(watcherId);
		return {
			stored,
			rules,
			...(reason === undefined ? {} : { reason }),
			invalid: invalidRules(rules.rules, deps.specsOf(watcherId) ?? []),
		};
	};

	/** The list moves a revision with every write, which is what a sort names. */
	const write = (watcherId: string, rules: AssistantRule[], otherwise: AssistantRuleOtherwise) => {
		const next: AssistantWatcherRules = { rules, otherwise, revision: get(watcherId).revision + 1 };
		const watchers = { ...state.watchers };
		Object.defineProperty(watchers, watcherId, {
			value: next,
			enumerable: true,
			writable: true,
			configurable: true,
		});
		if (!commit({ v: 1, watchers })) return answer(watcherId, false, "the rules could not be saved");
		return answer(watcherId, true);
	};

	const stale = (watcherId: string, held: number, base: number) =>
		answer(watcherId, false, `revision ${held} is stored; this edits ${base}`);

	/** A put's refusal before revisions; the preview's too. */
	const refusalOf = (watcherId: string, rule: AssistantRule): string | null => {
		const specs = deps.specsOf(watcherId);
		if (!specs) return `no watcher "${watcherId}"`;
		const parsed = parseRuleForFields(rule, specs);
		if (!parsed.ok) return parsed.reason;
		const held = get(watcherId).rules.some((existing) => existing.id === rule.id);
		if (!held && (rule.revision !== 0 || buried.has(graveOf(watcherId, rule.id)))) return "this rule was deleted";
		return null;
	};

	return {
		get,
		refusalOf,
		/** 0 adds; a repeat of what is held is a lost answer. */
		putRule(watcherId: string, incoming: AssistantRule): ConsoleAssistantRulesResult {
			const refusal = refusalOf(watcherId, incoming);
			if (refusal) return answer(watcherId, false, refusal);
			const candidate = canonicalRule(incoming);
			const held = get(watcherId);
			const current = held.rules.find((rule) => rule.id === candidate.id);
			const base = candidate.revision;
			if (current) {
				const echoes = base === current.revision || base === current.revision - 1;
				if (echoes && sameContent(candidate, current)) return answer(watcherId, true);
				if (base !== current.revision) return stale(watcherId, current.revision, base);
			} else {
				if (held.rules.length >= ASSISTANT_RULES_MAX) {
					return answer(watcherId, false, `a watcher holds at most ${ASSISTANT_RULES_MAX} rules`);
				}
			}
			const rule = { ...candidate, revision: (current?.revision ?? 0) + 1 };
			const rules = current
				? held.rules.map((existing) => (existing.id === rule.id ? rule : existing))
				: [...held.rules, rule];
			return write(watcherId, rules, held.otherwise);
		},
		/** One already gone answers deleted. */
		deleteRule(watcherId: string, ruleId: string, base: number): ConsoleAssistantRulesResult {
			if (!deps.specsOf(watcherId)) return answer(watcherId, false, `no watcher "${watcherId}"`);
			const held = get(watcherId);
			const current = held.rules.find((rule) => rule.id === ruleId);
			if (!current) return answer(watcherId, true);
			if (base !== current.revision) return stale(watcherId, current.revision, base);
			const landed = write(
				watcherId,
				held.rules.filter((rule) => rule.id !== ruleId),
				held.otherwise,
			);
			if (!landed.stored) return landed;
			buried.set(graveOf(watcherId, ruleId), current.revision);
			capFifo(buried, MAX_BURIED);
			return landed;
		},
		/**
		 * Directly before `beforeId`, or last without one, over the list revision the phone drew. One
		 * already in place answers stored, which is also a lost answer's repeat.
		 */
		moveRule(
			watcherId: string,
			ruleId: string,
			beforeId: string | undefined,
			base: number,
		): ConsoleAssistantRulesResult {
			if (!deps.specsOf(watcherId)) return answer(watcherId, false, `no watcher "${watcherId}"`);
			const held = get(watcherId);
			const moving = held.rules.find((rule) => rule.id === ruleId);
			if (!moving) return answer(watcherId, false, "this rule was deleted");
			const rest = held.rules.filter((rule) => rule.id !== ruleId);
			const at = beforeId === undefined ? rest.length : rest.findIndex((rule) => rule.id === beforeId);
			if (at < 0) return answer(watcherId, false, "the rule it goes before was deleted");
			const rules = [...rest.slice(0, at), moving, ...rest.slice(at)];
			if (rules.every((rule, index) => rule.id === held.rules[index]?.id)) return answer(watcherId, true);
			if (base !== held.revision) return stale(watcherId, held.revision, base);
			return write(watcherId, rules, held.otherwise);
		},
		putOtherwise(watcherId: string, incoming: AssistantRuleOtherwise): ConsoleAssistantRulesResult {
			if (!deps.specsOf(watcherId)) return answer(watcherId, false, `no watcher "${watcherId}"`);
			const held = get(watcherId);
			const current = held.otherwise;
			const base = incoming.revision;
			const echoes = base === current.revision || base === current.revision - 1;
			if (echoes && sameContent(incoming, current)) return answer(watcherId, true);
			if (base !== current.revision) return stale(watcherId, current.revision, base);
			return write(watcherId, held.rules, { ...incoming, revision: current.revision + 1 });
		},
		/**
		 * Every watcher's rules at once, as a move carries them; null is the default. A list revision
		 * climbs past both sides, so an edit drawn before the move is refused as stale.
		 */
		replaceAll(watcherIds: readonly string[], next: (watcherId: string) => AssistantWatcherRules | null): boolean {
			const watchers: Snapshot["watchers"] = Object.create(null);
			for (const watcherId of watcherIds) {
				const carried = structuredClone(next(watcherId) ?? DEFAULT_RULES);
				const revision = Math.max(get(watcherId).revision, carried.revision) + 1;
				watchers[watcherId] = { ...carried, revision };
			}
			return commit({ v: 1, watchers });
		},
	};
}

export type RulesStore = ReturnType<typeof createRulesStore>;
