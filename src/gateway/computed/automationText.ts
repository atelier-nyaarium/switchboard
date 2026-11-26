// An automation's texts with holes, and how its tells are told.

import { reached, STEP_PATH_RE, visit, written } from "../../shared/automation-walk.js";
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
	reached(body).flatMap((at) =>
		visit(at, { action: ({ action }) => (isTell(action) ? [action] : []), unfollowedCall: () => [] }),
	);

/** A step's field a save refused. */
export const STEP_ISSUE_CODE = "invalid_step";

/** `step`: numbers under its record. */
interface StepPlace {
	step: string;
	param?: string;
}

/** Path: list, step numbers, parameter, start, end. */
export const holeOwnerIssue = (
	at: Required<StepPlace>,
	issue: { start: number; end: number; message: string },
	list: "actions" | "steps" = "actions",
): OwnerIssue => ({
	path: [list, at.step, at.param, issue.start, issue.end],
	message: issue.message,
	code: HOLE_ISSUE_CODE,
});

/** Path: list, step numbers, parameter. */
export const stepOwnerIssue = (at: StepPlace, message: string): OwnerIssue => ({
	path: ["steps", at.step, ...(at.param ? [at.param] : [])],
	message,
	code: STEP_ISSUE_CODE,
});

/** The step a hole or step issue names. */
export function stepPlaceOf(issue: OwnerIssue | undefined): StepPlace | undefined {
	if (issue?.code !== HOLE_ISSUE_CODE && issue?.code !== STEP_ISSUE_CODE) return undefined;
	const [, step, param] = issue.path;
	if (typeof step !== "string" || !STEP_PATH_RE.test(step)) return undefined;
	return { step, ...(typeof param === "string" ? { param } : {}) };
}

/** `action`: its top-level index. */
export function holeSpanOf(issue: OwnerIssue | undefined) {
	if (issue?.code !== HOLE_ISSUE_CODE) return undefined;
	const place = stepPlaceOf(issue);
	const [, , , start, end] = issue.path;
	if (!place?.param || typeof start !== "number" || typeof end !== "number") return undefined;
	return { action: Number(place.step.split(".")[0]), step: place.step, param: place.param, start, end };
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
