// A crossing as a derived band field.

import type { CrossingTrigger } from "../../shared/schemasAutomation.js";
import type { ComputedField } from "./computedFields.js";

/** No record id holds a colon. */
export const crossingFieldId = (automationId: string): string => `crossing:${automationId}`;

/** The side that fires. */
export const crossingSide = (trigger: CrossingTrigger): "low" | "high" =>
	trigger.direction === "above" ? "high" : "low";

/** A crossing as a one-sided band. */
export function crossingField(trigger: CrossingTrigger): ComputedField {
	return {
		label: "Crossing",
		nodes: [
			{ kind: "field", ref: { source: "device", device: trigger.device, key: trigger.measure } },
			{
				kind: "band",
				input: 0,
				deadZone: trigger.deadZone,
				...(trigger.direction === "above" ? { high: trigger.threshold } : { low: trigger.threshold }),
			},
		],
	};
}
