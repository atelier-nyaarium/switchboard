// Actions outside the outbox.

import { errorName } from "../../shared/error-name.js";
import {
	AUTOMATION_ACTIONS,
	type AutomationAction,
	type AutomationActionParam,
} from "../../shared/schemasAutomation.js";
import type { DeviceVerb } from "../devices/driver.js";
import type { AttemptWord, Nature } from "./automationSteps.js";

/** A word, or a hold: nothing was sent. */
export type Attempt = { word: AttemptWord } | { hold: string };

/** An action with an effect to run. */
export type AutomationEffect = Exclude<AutomationAction, { kind: "tell_assistant" }>;

const VERB_NATURES: Readonly<Record<DeviceVerb, Nature>> = { on: "sets", off: "sets", toggle: "nudges" };

const NATURES: { [K in AutomationEffect["kind"]]: (action: Extract<AutomationEffect, { kind: K }>) => Nature } = {
	device_set: (action) => VERB_NATURES[action.verb],
	ifttt_trigger: () => "sends",
};

export const natureOf = (action: AutomationEffect): Nature =>
	(NATURES[action.kind] as (action: AutomationEffect) => Nature)(action);

export type IftttParams = Omit<Extract<AutomationAction, { kind: "ifttt_trigger" }>, "kind">;

export interface AutomationActionPorts {
	/** False: not attempted yet. */
	ready: (action: AutomationEffect) => boolean;
	/** Null when no switch is held under it. */
	switchName: (device: string) => string | null;
	deviceSet: (device: string, verb: DeviceVerb) => Promise<Attempt>;
	iftttTrigger: (params: IftttParams) => Promise<Attempt>;
}

export const isEffect = (action: AutomationAction): action is AutomationEffect => action.kind !== "tell_assistant";

type Runners = {
	[K in AutomationEffect["kind"]]: (
		action: Extract<AutomationEffect, { kind: K }>,
		ports: AutomationActionPorts,
	) => Promise<Attempt>;
};

const RUNNERS: Runners = {
	device_set: (action, ports) => ports.deviceSet(action.device, action.verb),
	ifttt_trigger: ({ kind: _kind, ...params }, ports) => ports.iftttTrigger(params),
};

/** A throw is no answer; its message is dropped. */
export async function runEffect(action: AutomationEffect, ports: AutomationActionPorts): Promise<Attempt> {
	try {
		const run = RUNNERS[action.kind] as (
			action: AutomationEffect,
			ports: AutomationActionPorts,
		) => Promise<Attempt>;
		return await run(action, ports);
	} catch (error) {
		console.warn(`[automations] an action threw: ${errorName(error)}`);
		return { word: "no_answer" };
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
