// An automation's texts with holes, and how its tells are told.

import {
	type FollowedEntry,
	type FunctionOf,
	reached,
	STEP_PATH_RE,
	steering,
	visit,
	written,
} from "../../shared/automation-walk.js";
import { type Automation, type AutomationAction, actionTexts, type TellWhen } from "../../shared/schemasAutomation.js";
import type { OwnerIssue } from "../ownerRecords.js";

export type Tell = Extract<AutomationAction, { kind: "tell_assistant" }>;

export const isTell = (action: AutomationAction): action is Tell => action.kind === "tell_assistant";

/** Indexed as written. */
export const holeTexts = (body: Pick<Automation, "actions">) => holeTextsOf(written(body));

export function holeTextsOf(actions: readonly AutomationAction[]): { action: number; param: string; text: string }[] {
	return actions.flatMap((action, at) => actionTexts(action).map((held) => ({ action: at, ...held })));
}

/** The paths of an automation's own tells, a function's aside. */
export const ownTellPaths = (body: Pick<Automation, "actions">): Set<string> =>
	new Set(
		reached(body).flatMap((at) =>
			visit(at, { action: ({ path, action }) => (isTell(action) ? [path] : []), unfollowedCall: () => [] }),
		),
	);

/** A tell the lane tells itself. */
export interface LaneTell {
	path: string;
	when: TellWhen;
}

const whenOf = (value: unknown): TellWhen | null => (value === "now" || value === "quietly" ? value : null);

/** An event automation's leading tells with no message, through its function's first steps. */
export function laneTells(body: Automation, functionOf: FunctionOf): LaneTell[] {
	if (body.trigger.kind !== "event") return [];
	const found: LaneTell[] = [];
	for (const at of reached(body, functionOf)) {
		const tell = visit<FollowedEntry, LaneTell | null>(at, {
			action: ({ path, action }) =>
				isTell(action) && action.message === undefined ? { path, when: action.when } : null,
			step: {
				do: ({ path, address, step }) => {
					const { when, message } = step.args;
					if (address.length !== 1 || step.action !== "tell_assistant" || message !== undefined) return null;
					const told = when?.kind === "literal" ? whenOf(when.value) : null;
					return told && { path, when: told };
				},
				call: () => null,
				...steering((): LaneTell | null => null),
			},
			unfollowedCall: () => null,
		});
		if (!tell) break;
		found.push(tell);
	}
	return found;
}

/** Now outranks quietly; null when the lane tells nothing. */
export const laneTellWhen = (body: Automation, functionOf: FunctionOf): TellWhen | null => {
	const tells = laneTells(body, functionOf);
	if (tells.length === 0) return null;
	return tells.some((tell) => tell.when === "now") ? "now" : "quietly";
};

/** A step's field a save refused. */
export const STEP_ISSUE_CODE = "invalid_step";

/** `step`: numbers under its record. */
interface StepPlace {
	step: string;
	param?: string;
}

/** Path: list, step numbers, parameter. */
export const stepOwnerIssue = (at: StepPlace, message: string): OwnerIssue => ({
	path: ["steps", at.step, ...(at.param ? [at.param] : [])],
	message,
	code: STEP_ISSUE_CODE,
});

/** Issue step path. */
export function stepPlaceOf(issue: OwnerIssue | undefined): StepPlace | undefined {
	if (issue?.code !== STEP_ISSUE_CODE) return undefined;
	const [, step, param] = issue.path;
	if (typeof step !== "string" || !STEP_PATH_RE.test(step)) return undefined;
	return { step, ...(typeof param === "string" ? { param } : {}) };
}
