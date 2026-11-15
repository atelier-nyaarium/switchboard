// How an automation's effects reach the devices and IFTTT.

import type {
	IftttTriggerAnswer,
	IftttTriggerRequest,
	UnavailableReason,
} from "../../shared/schemasPhoneCapabilities.js";
import { GatewayCapabilityRefusal } from "../assistant/gatewayCapabilityRefusal.js";
import type { ActionOutcome, AutomationActionPorts, AutomationEffect } from "../computed/automationRunner.js";
import type { DeviceStage } from "./composeDevices.js";

export interface AutomationActionsDeps {
	/** Undefined until composed. */
	devices: () => Pick<DeviceStage, "record" | "automationSet"> | undefined;
	ifttt: (params: IftttTriggerRequest) => Promise<IftttTriggerAnswer>;
	/** Vault can answer reads. */
	vaultReady: () => boolean;
}

/** Otherwise refused. */
const REFUSAL_OUTCOMES: Partial<Record<UnavailableReason, ActionOutcome["outcome"]>> = {
	timeout: "uncertain",
	not_ready: "not_started",
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
			if (!devices) return { outcome: "not_started", reason: "devices are not loaded" };
			const answer = await devices.automationSet(device, verb);
			if (answer === "not_started") return { outcome: "not_started", reason: "nothing was sent in time" };
			if (answer.kind === "ok") return { outcome: "ran" };
			const { code, effect } = answer.refusal;
			return { outcome: effect === "none" ? "refused" : "uncertain", reason: code };
		},
		iftttTrigger: async (params) => {
			try {
				const { ok, status } = await deps.ifttt(params);
				if (ok) return { outcome: "ran" };
				// No response may still have fired.
				return status === 0
					? { outcome: "uncertain", reason: "no response from IFTTT" }
					: { outcome: "refused", reason: `IFTTT answered ${status}` };
			} catch (error) {
				if (!(error instanceof GatewayCapabilityRefusal)) throw error;
				const outcome = REFUSAL_OUTCOMES[error.reason] ?? "refused";
				return { outcome, reason: error.reason };
			}
		},
	};
}
