// What makes an automation invalid or unarmed on this Gateway.

import { type FunctionOf, reached } from "../../shared/automation-walk.js";
import { AUTOMATION_TRIGGER_NAMES, type Automation } from "../../shared/schemasAutomation.js";
import { hasHoles } from "../../shared/text-holes.js";
import type { OwnerIssue, OwnerRecord } from "../ownerRecords.js";
import { clockIssue, isClock } from "./automationClock.js";
import { type EffectKind, effectIssue, isEffect } from "./automationRunner.js";
import type { AutomationsDeps } from "./automations.js";
import { holeOwnerIssue, holeTexts } from "./automationText.js";
import { crossingField } from "./crossingBand.js";

export type ValidityDeps = Pick<AutomationsDeps, "fields" | "reading" | "eventIssue" | "holes" | "actions">;

const STEP_ACTIONS: Readonly<Record<EffectKind | "tell_assistant", true>> = {
	tell_assistant: true,
	device_set: true,
	ifttt_trigger: true,
};
const stepAction = (kind: string): boolean => Object.hasOwn(STEP_ACTIONS, kind);

export const FUNCTION_GONE = "the function it runs is gone";
export const FUNCTION_UNREAD = "the function it runs was written by a newer build; update this Gateway";

/** `unread`: a function row held but not readable here. */
export function createAutomationValidity(
	deps: ValidityDeps,
	functionOf: FunctionOf,
	unread: (id: string) => boolean = () => false,
) {
	function triggerIssue(body: Pick<Automation, "trigger">): string | null {
		if (body.trigger.kind === "event") {
			return deps.eventIssue ? deps.eventIssue(body.trigger) : "this Gateway holds no sources";
		}
		if (body.trigger.kind === "crossing") {
			const { device, measure } = body.trigger;
			if (!deps.reading?.(device, measure)) return "no such number on this Gateway";
			return deps.fields.check(crossingField(body.trigger));
		}
		if (isClock(body.trigger)) return clockIssue(body.trigger);
		const { field, becomes } = body.trigger;
		const type = deps.fields.typeOf(field);
		if (!type) return deps.fields.invalidOf(field) ?? "no such field";
		if (type.type === "boolean") return typeof becomes === "boolean" ? null : "this field is true or false";
		if (type.type === "choice") {
			return typeof becomes === "string" && type.members.includes(becomes)
				? null
				: `${String(becomes)} is not one of its values`;
		}
		return "only a field of choices or true and false can trigger";
	}

	/** First refused hole and span. */
	function holesIssue(body: Automation): OwnerIssue | null {
		const holes = deps.holes?.();
		const names = AUTOMATION_TRIGGER_NAMES[body.trigger.kind];
		for (const at of holeTexts(body)) {
			if (!hasHoles(at.text)) continue;
			if (!holes)
				return holeOwnerIssue(at, { start: 0, end: at.text.length, message: "holes cannot be read yet" });
			const issue = holes.issue(at.text, names);
			if (issue) return holeOwnerIssue(at, issue);
		}
		return null;
	}

	/** Why this Gateway cannot run it. */
	function automationIssue(body: Automation, functions: FunctionOf = functionOf): string | null {
		const issue = triggerIssue(body);
		if (issue !== null) return issue;
		for (const at of reached(body, functions)) {
			if (!("action" in at)) {
				if (!stepAction(at.kind)) return "a step does what this Gateway cannot run";
				continue;
			}
			if (at.action.kind === "run_function") return unread(at.action.function) ? FUNCTION_UNREAD : FUNCTION_GONE;
			const refused = isEffect(at.action) ? effectIssue(at.action, deps.actions) : null;
			if (refused !== null) return refused;
		}
		return holesIssue(body)?.message ?? null;
	}

	const armed = (record: OwnerRecord<Automation>) => record.body.enabled && automationIssue(record.body) === null;

	return { triggerIssue, holesIssue, automationIssue, armed };
}
