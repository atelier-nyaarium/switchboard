// What an automation's editor is shown before a save.

import type { ConsoleOp } from "../../shared/console-protocol.js";
import {
	AUTOMATION_TRIGGER_NAMES,
	type AutomationTrigger,
	type ConsoleAutomationPreviewResult,
	type EventTrigger,
} from "../../shared/schemasAutomation.js";
import { oneLine } from "../../shared/system-reminder.js";
import { functionScopeOf, placeholderNames, placeholderScope } from "./automationScope.js";
import type { AutomationPlaceholders } from "./automations.js";

type Names = Parameters<AutomationPlaceholders["fill"]>[1];

export interface AutomationPreviewDeps {
	/** Throws what a put would refuse. */
	event: (trigger: EventTrigger) => Promise<{ preview: ConsoleAutomationPreviewResult; names: Names | null }>;
	/** Throws what a put would refuse. */
	namesNow: (trigger: Exclude<AutomationTrigger, EventTrigger>) => Names;
	placeholders: () => AutomationPlaceholders | undefined;
	deviceName?: (device: string) => string | null;
}

export type PreviewRequest = Omit<Extract<ConsoleOp, { kind: "automation_preview" }>, "kind">;

const NAME_SHOWN_MAX = 200;
const NOT_BOOLEAN = "the newest event makes it neither true nor false";
const ISSUE_MAX = 200;
const FILLED_MAX = 4_000;

type Judged = NonNullable<ConsoleAutomationPreviewResult["condition"]>;

const shownOf = (held: Names[string]): string => {
	const text = held.shown ?? (typeof held.value === "object" ? "a record" : String(held.value ?? "none"));
	return oneLine(text).slice(0, NAME_SHOWN_MAX);
};

export async function previewAutomation(
	deps: AutomationPreviewDeps,
	{ trigger, text, params = [], args, condition, variables = [] }: PreviewRequest,
): Promise<ConsoleAutomationPreviewResult> {
	const seen = trigger.kind === "event" ? await deps.event(trigger) : null;
	const names = seen ? seen.names : deps.namesNow(trigger as Exclude<AutomationTrigger, EventTrigger>);
	const preview = seen?.preview ?? { matched: 0, of: 0, matches: [] };
	const paramNames = functionScopeOf(params, args, deps.deviceName);
	const listed = AUTOMATION_TRIGGER_NAMES[trigger.kind]
		.flatMap((name) => {
			const held = names?.[name];
			return held ? [{ name, shown: shownOf(held) }] : [{ name, shown: "nothing yet" }];
		})
		.concat(
			params.map((param) => ({
				name: param.name,
				shown: paramNames[param.name] ? shownOf(paramNames[param.name]) : "not set",
			})),
		);
	const placeholders = deps.placeholders();
	const scope = placeholderNames(AUTOMATION_TRIGGER_NAMES[trigger.kind], params);

	/** A save's issue, else a warning only an event's own value can raise. */
	const judge = async (source: string): Promise<Judged> => {
		if (!placeholders) return {};
		const found = placeholders.expression(source, [...scope, ...variables]);
		if (found) return { issue: { ...found, message: oneLine(found.message).slice(0, ISSUE_MAX) } };
		// A variable wins over one of the same spelling, so it parses only without them.
		const readsVariable =
			placeholders.expression(
				source,
				scope.filter((name) => !variables.includes(name)),
			) !== null;
		if (readsVariable || !seen || !names?.event) return {};
		const value = await placeholders.evaluate(source, placeholderScope(names, params, args, deps.deviceName));
		return value !== null && typeof value.value !== "boolean" ? { warning: NOT_BOOLEAN } : {};
	};

	const judged = condition === undefined ? {} : { condition: await judge(condition) };
	if (text === undefined) return { ...preview, names: listed, ...judged };
	const found = placeholders?.issue(text, scope) ?? null;
	const placeholder = found ? { ...found, message: oneLine(found.message).slice(0, ISSUE_MAX) } : null;
	if (!placeholders || placeholder) {
		return { ...preview, names: listed, ...judged, ...(placeholder ? { placeholder } : {}) };
	}
	const filled = await placeholders.fill(text, placeholderScope(names, params, args, deps.deviceName));
	return { ...preview, names: listed, ...judged, filled: filled.text.slice(0, FILLED_MAX) };
}
