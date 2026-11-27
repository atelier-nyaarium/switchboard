// What an automation's editor is shown before a save.

import type { ConsoleOp } from "../../shared/console-protocol.js";
import {
	AUTOMATION_TRIGGER_NAMES,
	type AutomationTrigger,
	type ConsoleAutomationPreviewResult,
	type EventTrigger,
} from "../../shared/schemasAutomation.js";
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

export type PreviewRequest = Omit<Extract<ConsoleOp, { kind: "automation_preview" }>, "kind">;

const NAME_SHOWN_MAX = 200;
const RUN_VALUE = "it reads a value an earlier step keeps";
const UNREAD_NOW = "it cannot be read now";
const NO_EVENT_YET = "no event has come in yet";
const NOT_BOOLEAN = "it is not true or false";
const ISSUE_MAX = 200;
const FILLED_MAX = 4_000;

const shownOf = (held: Names[string]): string => {
	const text = held.shown ?? (typeof held.value === "object" ? "a record" : String(held.value ?? "none"));
	return oneLine(text).slice(0, NAME_SHOWN_MAX);
};

export async function previewAutomation(
	deps: AutomationPreviewDeps,
	{ trigger, text, params = [], values, condition, runNames = [] }: PreviewRequest,
): Promise<ConsoleAutomationPreviewResult> {
	const seen = trigger.kind === "event" ? await deps.event(trigger) : null;
	const names = seen ? seen.names : deps.namesNow(trigger as Exclude<AutomationTrigger, EventTrigger>);
	const preview = seen?.preview ?? { matched: 0, of: 0, matches: [] };
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
	const holes = deps.holes();
	const scope = holeNames(AUTOMATION_TRIGGER_NAMES[trigger.kind], params);
	const judged =
		condition === undefined
			? {}
			: {
					condition: await (async (): Promise<NonNullable<ConsoleAutomationPreviewResult["condition"]>> => {
						if (!holes) return { unread: UNREAD_NOW };
						const found = holes.expression(condition, [...scope, ...runNames]);
						if (found) return { issue: { ...found, message: oneLine(found.message).slice(0, ISSUE_MAX) } };
						// A run's name wins over one of the same spelling, so it parses only without them.
						if (
							holes.expression(
								condition,
								scope.filter((name) => !runNames.includes(name)),
							)
						)
							return { unread: RUN_VALUE };
						const value = await holes.evaluate(
							condition,
							holeScope(names, params, values, deps.switchName),
						);
						if (value === null) return { unread: seen && !names?.event ? NO_EVENT_YET : UNREAD_NOW };
						return typeof value.value === "boolean" ? { holds: value.value } : { unread: NOT_BOOLEAN };
					})(),
				};
	if (text === undefined) return { ...preview, names: listed, ...judged };
	const found = holes?.issue(text, scope) ?? null;
	const hole = found ? { ...found, message: oneLine(found.message).slice(0, ISSUE_MAX) } : null;
	if (!holes || hole) return { ...preview, names: listed, ...judged, ...(hole ? { hole } : {}) };
	const filled = await holes.fill(text, holeScope(names, params, values, deps.switchName));
	return { ...preview, names: listed, ...judged, filled: filled.text.slice(0, FILLED_MAX) };
}
