// Band field plus automations.

import type { ExpressionNode } from "../../shared/expressions.js";
import type { Automation } from "./automations.js";
import type { ComputedField } from "./computedFields.js";

export const THRESHOLD_SIDES = ["low", "high"] as const;
export type ThresholdSide = (typeof THRESHOLD_SIDES)[number];

export interface Threshold {
	device: string;
	measure: string;
	/** Shown in the alert. */
	label: string;
	low?: number;
	high?: number;
	deadZone: number;
	coolDownSec: number;
}

/** Template-owned record ids. */
export function thresholdIds(device: string, measure: string) {
	const base = `threshold-${device.replaceAll(":", "")}-${measure}`;
	return { field: base, low: `${base}-low`, high: `${base}-high` };
}

/** Null when no side set. */
export function thresholdField(threshold: Threshold): ComputedField | null {
	if (threshold.low === undefined && threshold.high === undefined) return null;
	const band: ExpressionNode = {
		kind: "band",
		input: 0,
		deadZone: threshold.deadZone,
		...(threshold.low === undefined ? {} : { low: threshold.low }),
		...(threshold.high === undefined ? {} : { high: threshold.high }),
	};
	return {
		label: threshold.label,
		nodes: [{ kind: "field", ref: { source: "device", device: threshold.device, key: threshold.measure } }, band],
	};
}

export function thresholdAutomations(threshold: Threshold): Record<ThresholdSide, Automation> {
	const ids = thresholdIds(threshold.device, threshold.measure);
	const side = (which: ThresholdSide): Automation => ({
		label: `${threshold.label} ${which === "low" ? "below" : "above"} ${threshold[which] ?? ""}`.trim(),
		enabled: threshold[which] !== undefined,
		trigger: { field: ids.field, becomes: which },
		action: { kind: "tell_assistant" },
		coolDownSec: threshold.coolDownSec,
	});
	return { low: side("low"), high: side("high") };
}
