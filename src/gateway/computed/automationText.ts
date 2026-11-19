// An automation's texts with holes, and how its tells are told.

import { reached, written } from "../../shared/automation-walk.js";
import {
	type Automation,
	type AutomationAction,
	actionTexts,
	type TellWhen,
	tellWhenOf,
} from "../../shared/schemasAutomation.js";
import { hasHoles } from "../../shared/text-holes.js";
import type { OwnerIssue } from "../ownerRecords.js";

/** A hole a save refused. */
export const HOLE_ISSUE_CODE = "invalid_hole";

type Tell = Extract<AutomationAction, { kind: "tell_assistant" }>;

export const isTell = (action: AutomationAction): action is Tell => action.kind === "tell_assistant";

/** Indexed as written. */
export const holeTexts = (body: Pick<Automation, "actions">) => holeTextsOf(written(body));

export function holeTextsOf(actions: readonly AutomationAction[]): { action: number; param: string; text: string }[] {
	return actions.flatMap((action, at) => actionTexts(action).map((held) => ({ action: at, ...held })));
}

const tellsOf = (body: Pick<Automation, "actions">): Tell[] =>
	reached(body).flatMap(({ action }) => (isTell(action) ? [action] : []));

/** Path: actions, index, parameter, start, end. */
export const holeOwnerIssue = (
	at: { action: number; param: string },
	issue: { start: number; end: number; message: string },
): OwnerIssue => ({
	path: ["actions", at.action, at.param, issue.start, issue.end],
	message: issue.message,
	code: HOLE_ISSUE_CODE,
});

/** The span a hole issue's path carries. */
export function holeSpanOf(issue: OwnerIssue | undefined) {
	if (issue?.code !== HOLE_ISSUE_CODE) return undefined;
	const [, action, param, start, end] = issue.path;
	if (typeof action !== "number" || typeof param !== "string" || typeof start !== "number" || typeof end !== "number")
		return undefined;
	return { action, param, start, end };
}

/** How one firing tells the assistant. */
export interface TellPlan {
	/** Null when nothing is told. */
	when: TellWhen | null;
	messages: string[];
	/** A message needs its holes read. */
	filling: boolean;
}

/** Message-less event tells are the lane's. */
export function tellPlan(body: Automation): TellPlan {
	const tells = tellsOf(body).filter((tell) => body.trigger.kind !== "event" || tell.message !== undefined);
	const messages = tells.flatMap((tell) => (tell.message === undefined ? [] : [tell.message]));
	return { when: tellWhenOf(tells), messages, filling: messages.some(hasHoles) };
}

/** Message-less tells. */
export const laneTellWhen = (body: Automation): TellWhen | null =>
	tellWhenOf(tellsOf(body).filter((tell) => tell.message === undefined));
