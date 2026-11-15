// A sensor's alerts, and a crossing's band.

import type { Automation, CrossingDirection, CrossingTrigger } from "../../shared/schemasAutomation.js";
import type { ComputedField } from "./computedFields.js";

export const THRESHOLD_SIDES = ["low", "high"] as const;
export type ThresholdSide = (typeof THRESHOLD_SIDES)[number];

export interface Threshold {
	device: string;
	measure: string;
	low?: number;
	high?: number;
	deadZone: number;
	coolDownSec: number;
}

/** Ids a sensor's alerts take. */
export const ALERT_ID_PREFIX = "threshold-";

/** Template-owned record ids. */
export function thresholdIds(device: string, measure: string) {
	const base = `${ALERT_ID_PREFIX}${device.replaceAll(":", "")}-${measure}`;
	return { field: base, low: `${base}-low`, high: `${base}-high` };
}

const DIRECTIONS: Record<ThresholdSide, CrossingDirection> = { low: "below", high: "above" };

/** One crossing per side that is set. */
export function thresholdAutomations(threshold: Threshold): Partial<Record<ThresholdSide, Automation>> {
	const side = (which: ThresholdSide): Automation | undefined => {
		const at = threshold[which];
		if (at === undefined) return undefined;
		return {
			enabled: true,
			trigger: {
				kind: "crossing",
				device: threshold.device,
				measure: threshold.measure,
				direction: DIRECTIONS[which],
				threshold: at,
				deadZone: threshold.deadZone,
				coolDownSec: threshold.coolDownSec,
			},
			actions: [{ kind: "tell_assistant", when: "quietly" }],
		};
	};
	const [low, high] = [side("low"), side("high")];
	return { ...(low ? { low } : {}), ...(high ? { high } : {}) };
}

/** No record id holds a colon. */
export const crossingFieldId = (automationId: string): string => `crossing:${automationId}`;

/** The side that fires. */
export const crossingSide = (trigger: CrossingTrigger): ThresholdSide =>
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
