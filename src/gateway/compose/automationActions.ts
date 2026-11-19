// Automation effects to devices and IFTTT.

import type { DeviceRefusalCode } from "../../shared/schemasDevices.js";
import type { DeviceToolResult } from "../../shared/schemasDeviceTool.js";
import type {
	IftttTriggerAnswer,
	IftttTriggerRequest,
	UnavailableReason,
} from "../../shared/schemasPhoneCapabilities.js";
import { GatewayCapabilityRefusal } from "../assistant/gatewayCapabilityRefusal.js";
import type { Attempt, AutomationActionPorts, AutomationEffect } from "../computed/automationRunner.js";
import type { AttemptWord } from "../computed/automationSteps.js";
import type { DeviceStage } from "./composeDevices.js";

export interface AutomationActionsDeps {
	/** Undefined until composed. */
	devices: () => Pick<DeviceStage, "record" | "automationSet"> | undefined;
	ifttt: (params: IftttTriggerRequest) => Promise<IftttTriggerAnswer>;
	/** Vault can answer reads. */
	vaultReady: () => boolean;
}

/** Latch unmarked; marked is no answer. */
const DEVICE_CODE_WORDS: Readonly<Record<DeviceRefusalCode, AttemptWord>> = {
	not_found: "refused",
	stale: "refused",
	exists: "refused",
	full: "refused",
	invalid: "refused",
	wrong_device: "refused",
	not_supported: "refused",
	toggle_unknown: "refused",
	unreachable: "unreachable",
	timeout: "unreachable",
	device_error: "refused",
	write_failed: "refused",
	daemon_away: "unreachable",
	scan_failed: "unreachable",
	no_radio: "unreachable",
};

type DeviceAnswer = DeviceToolResult<"device_set"> | "not_started";

/** `not_started`: the lease ended before its turn. */
export function deviceAttempt(answer: DeviceAnswer): Attempt {
	if (answer === "not_started") return { hold: "nothing was sent in time" };
	if (answer.kind === "ok") return { word: "done" };
	const { code, effect } = answer.refusal;
	return { word: effect === "unknown" ? "no_answer" : DEVICE_CODE_WORDS[code] };
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
			return deviceAttempt(await devices.automationSet(device, verb));
		},
		iftttTrigger: async (params) => {
			try {
				const { ok, status } = await deps.ifttt(params);
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
