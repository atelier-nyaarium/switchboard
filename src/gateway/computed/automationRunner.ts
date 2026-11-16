// Actions outside the outbox.

import { errorName } from "../../shared/error-name.js";
import {
	AUTOMATION_ACTIONS,
	type AutomationAction,
	type AutomationActionParam,
} from "../../shared/schemasAutomation.js";
import type { DeviceVerb } from "../devices/driver.js";

/** `uncertain` may have landed; `not_started` sent nothing. */
export type ActionOutcome = { outcome: "ran" } | { outcome: "refused" | "uncertain" | "not_started"; reason: string };

/** An action with an effect to run. */
export type AutomationEffect = Exclude<AutomationAction, { kind: "tell_assistant" }>;

export type IftttParams = Omit<Extract<AutomationAction, { kind: "ifttt_trigger" }>, "kind">;

export interface AutomationActionPorts {
	/** False: not attempted yet. */
	ready: (action: AutomationEffect) => boolean;
	/** Null when no switch is held under it. */
	switchName: (device: string) => string | null;
	deviceSet: (device: string, verb: DeviceVerb) => Promise<ActionOutcome>;
	iftttTrigger: (params: IftttParams) => Promise<ActionOutcome>;
}

export const isEffect = (action: AutomationAction): action is AutomationEffect => action.kind !== "tell_assistant";

type Runners = {
	[K in AutomationEffect["kind"]]: (
		action: Extract<AutomationEffect, { kind: K }>,
		ports: AutomationActionPorts,
	) => Promise<ActionOutcome>;
};

const RUNNERS: Runners = {
	device_set: (action, ports) => ports.deviceSet(action.device, action.verb),
	ifttt_trigger: ({ kind: _kind, ...params }, ports) => ports.iftttTrigger(params),
};

/** Never throws; a throw is uncertain, its message never kept. */
export async function runEffect(action: AutomationEffect, ports: AutomationActionPorts): Promise<ActionOutcome> {
	try {
		const run = RUNNERS[action.kind] as (
			action: AutomationEffect,
			ports: AutomationActionPorts,
		) => Promise<ActionOutcome>;
		return await run(action, ports);
	} catch (error) {
		console.warn(`[automations] an action threw: ${errorName(error)}`);
		return { outcome: "uncertain", reason: "the action failed unexpectedly" };
	}
}

/** Why this Gateway cannot run it. */
export function effectIssue(action: AutomationEffect, ports: AutomationActionPorts | undefined): string | null {
	if (!ports) return "this Gateway runs no such action";
	const params: readonly AutomationActionParam[] = AUTOMATION_ACTIONS[action.kind].params;
	const held: Record<string, unknown> = action;
	const gone = params.some((param) => param.kind === "switch" && ports.switchName(String(held[param.name])) === null);
	return gone ? "no such switch on this Gateway" : null;
}
