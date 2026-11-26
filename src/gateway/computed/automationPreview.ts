// What an automation's editor is shown before a save.

import {
	AUTOMATION_TRIGGER_NAMES,
	type AutomationTrigger,
	type ConsoleAutomationPreviewResult,
	type EventTrigger,
	type FunctionValues,
} from "../../shared/schemasAutomation.js";
import type { FunctionParam } from "../../shared/schemasFunction.js";
import { oneLine } from "../../shared/system-reminder.js";
import { functionScopeOf, holeNames, holeScope } from "./automationScope.js";
import type { AutomationHoles } from "./automations.js";

type Names = Parameters<AutomationHoles["fill"]>[1];

export interface AutomationPreviewDeps {
	/** Throws what a put would refuse. */
	event: (trigger: EventTrigger) => Promise<{ preview: ConsoleAutomationPreviewResult; names: Names | null }>;
	/** Throws what a put would refuse. */
	namesNow: (trigger: Exclude<AutomationTrigger, EventTrigger>) => Names;
	holes: () => AutomationHoles | undefined;
	switchName?: (device: string) => string | null;
}

const NAME_SHOWN_MAX = 200;
const ISSUE_MAX = 200;
const FILLED_MAX = 4_000;

const shownOf = (held: Names[string]): string => {
	const text = held.shown ?? (typeof held.value === "object" ? "a record" : String(held.value ?? "none"));
	return oneLine(text).slice(0, NAME_SHOWN_MAX);
};

export async function previewAutomation(
	deps: AutomationPreviewDeps,
	trigger: AutomationTrigger,
	text?: string,
	params: readonly FunctionParam[] = [],
	values?: FunctionValues,
): Promise<ConsoleAutomationPreviewResult> {
	const read = trigger.kind === "event" ? await deps.event(trigger) : null;
	const names = read ? read.names : deps.namesNow(trigger as Exclude<AutomationTrigger, EventTrigger>);
	const preview = read?.preview ?? { matched: 0, of: 0, matches: [] };
	const paramNames = functionScopeOf(params, values, deps.switchName);
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
	if (text === undefined) return { ...preview, names: listed };
	const holes = deps.holes();
	const found = holes?.issue(text, holeNames(AUTOMATION_TRIGGER_NAMES[trigger.kind], params)) ?? null;
	const hole = found ? { ...found, message: oneLine(found.message).slice(0, ISSUE_MAX) } : null;
	if (!holes || hole) return { ...preview, names: listed, ...(hole ? { hole } : {}) };
	const filled = await holes.fill(text, holeScope(names, params, values, deps.switchName));
	return { ...preview, names: listed, filled: filled.text.slice(0, FILLED_MAX) };
}
