// Automation effects to devices and IFTTT.

import type {
	IftttTriggerAnswer,
	IftttTriggerRequest,
	UnavailableReason,
} from "../../shared/schemasPhoneCapabilities.js";
import { GatewayCapabilityRefusal } from "../assistant/gatewayCapabilityRefusal.js";
import type { Attempt, AutomationActionPorts, AutomationEffect } from "../computed/automationRunner.js";
import type { AttemptWord } from "../computed/automationSteps.js";
import type { DeviceDriverError } from "../devices/driver.js";
import type { Outcome } from "../devices/road.js";
import { AUTOMATION_ATTEMPT_MS, type DeviceStage } from "./composeDevices.js";

export interface AutomationActionsDeps {
	/** Undefined until composed. */
	devices: () => Pick<DeviceStage, "record" | "automationSet"> | undefined;
	ifttt: (params: IftttTriggerRequest, bound?: number) => Promise<IftttTriggerAnswer>;
	/** Vault can answer reads. */
	vaultReady: () => boolean;
}

/** A driver failure whose effect did not land. */
const FAILURE_WORDS: Readonly<Record<DeviceDriverError["kind"], AttemptWord>> = {
	unreachable: "unreachable",
	timeout: "unreachable",
	refused: "refused",
	invalid: "refused",
	wrong_device: "refused",
};

export function attemptOf(outcome: Outcome<void>): Attempt {
	if (outcome.ok) return { word: "done" };
	const why = outcome.why;
	if (why.kind === "notStarted") return { hold: "nothing was sent in time" };
	if (why.effect === "unknown") return { word: "no_answer" };
	return { word: why.kind === "refused" ? "refused" : FAILURE_WORDS[why.failure.kind] };
}

/** Otherwise refused. */
const IFTTT_REFUSALS: Partial<Record<UnavailableReason, Attempt>> = {
	timeout: { word: "no_answer" },
	unreachable: { word: "unreachable" },
	not_ready: { hold: "its service was not ready" },
};

export function automationActions(deps: AutomationActionsDeps): AutomationActionPorts {
	const ready: Record<AutomationEffect["kind"], () => boolean> = {
		device_set: () => true,
		// A missing grant is a refusal, not unreadiness.
		ifttt_trigger: () => deps.vaultReady(),
	};
	return {
		ready: (action) => ready[action.kind](),
		switchName: (device) => {
			const record = deps.devices()?.record(device);
			return record?.kind === "switch" ? record.name : null;
		},
		deviceSet: async (device, verb) => {
			const devices = deps.devices();
			if (!devices) return { hold: "devices are not loaded" };
			return attemptOf(await devices.automationSet(device, verb));
		},
		iftttTrigger: async (params) => {
			try {
				const { ok, status } = await deps.ifttt(params, AUTOMATION_ATTEMPT_MS);
				if (ok) return { word: "done" };
				// No response may still have fired.
				return { word: status === 0 ? "no_answer" : "refused" };
			} catch (error) {
				if (!(error instanceof GatewayCapabilityRefusal)) throw error;
				return IFTTT_REFUSALS[error.reason] ?? { word: "refused" };
			}
		},
	};
}
