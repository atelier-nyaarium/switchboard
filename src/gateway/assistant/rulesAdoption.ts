// Stored watcher rules, read once into event automations.
// Remove 2026-11-28, deleting `assistant-rules.json` and its mark from the data directory.

import { z } from "zod";
import { type DurableStore, writeChecked } from "../../shared/durable-store.js";
import {
	AssistantRuleConditionSchema,
	AssistantRuleOtherwiseSchema,
	AssistantRuleSchema,
	type AssistantWatcherRules,
	AssistantWatcherRulesSchema,
} from "../../shared/schemasAssistantRules.js";
import { automationsOfRules, type CarriedAutomation } from "../../shared/schemasAutomation.js";
import { ASSISTANT_RULE_CONDITIONS_MAX, ASSISTANT_RULES_MAX } from "../../shared/wire-vocabulary.js";

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

type Loose = Record<string, unknown>;

const isLoose = (value: unknown): value is Loose => typeof value === "object" && value !== null;

function withoutPing(rule: Loose): Loose {
	const { ping: _ping, ...kept } = rule;
	return kept;
}

/** Legacy shapes, before the parse. */
function decodedLegacy(raw: unknown): unknown {
	if (!isLoose(raw) || !isLoose(raw.watchers)) return raw;
	// Source ids stay plain keys.
	const watchers: Loose = Object.create(null);
	for (const [watcherId, held] of Object.entries(raw.watchers)) {
		if (!isLoose(held) || !Array.isArray(held.rules) || !isLoose(held.otherwise)) {
			watchers[watcherId] = held;
			continue;
		}
		const rules = held.rules.filter((rule) => !isLoose(rule) || rule.action !== "drop");
		const otherwise = withoutPing({
			...held.otherwise,
			...(held.otherwise.action === "drop" ? { action: "inbox" } : {}),
		});
		watchers[watcherId] = {
			...held,
			rules: rules.map((rule) => (isLoose(rule) ? withoutPing(rule) : rule)),
			otherwise,
		};
	}
	return { ...raw, watchers };
}

/** Null when the file cannot be read. */
export function storedRules(store: DurableStore): Record<string, AssistantWatcherRules> | null {
	const loaded = store.load();
	if (loaded === null) return {};
	const parsed = SnapshotSchema.safeParse(decodedLegacy(loaded));
	return parsed.success ? parsed.data.watchers : null;
}

/** A let-go leaves no rules, as it did before automations. */
export function clearStoredRules(rules: DurableStore): boolean {
	const held = storedRules(rules);
	if (held !== null && Object.keys(held).length === 0) return true;
	return writeChecked(rules, { v: 1, watchers: {} }, "assistant rules").landed;
}

export interface RulesAdoptionDeps {
	rules: DurableStore;
	/** Written once the rules are adopted. */
	mark: DurableStore;
	now: () => number;
	/** Why this Gateway cannot run it, or null. */
	issue: (carried: CarriedAutomation) => string | null;
	/** True once held under its id. */
	adopt: (carried: CarriedAutomation) => boolean;
}

/** Runs until every rule that woke is an automation; then never again. */
export function adoptStoredRules(deps: RulesAdoptionDeps): void {
	if (deps.mark.load() !== null) return;
	const held = storedRules(deps.rules);
	if (held === null) {
		console.warn("[assistant] stored rules are unreadable; none became an automation");
		return;
	}
	let adopted = 0;
	for (const [sourceId, rules] of Object.entries(held)) {
		// Order does not except.
		const lastWake = rules.rules.map((rule) => rule.action).lastIndexOf("wake");
		const excepting = rules.rules.filter(
			(rule, at) => rule.action === "inbox" && (rules.otherwise.action === "wake" || at < lastWake),
		);
		if (excepting.length > 0) {
			console.warn(`[assistant] ${sourceId}: ${excepting.length} inbox rule(s) no longer except a wake`);
		}
		for (const carried of automationsOfRules(sourceId, rules)) {
			const issue = deps.issue(carried);
			if (issue !== null) {
				console.warn(`[assistant] ${sourceId}: rule ${carried.id} not carried: ${issue}`);
				continue;
			}
			if (!deps.adopt(carried)) {
				console.warn(`[assistant] ${sourceId}: rule ${carried.id} not saved; adopting again at the next start`);
				return;
			}
			adopted += 1;
		}
	}
	writeChecked(deps.mark, { v: 1, at: deps.now(), adopted }, "assistant rules mark");
}
