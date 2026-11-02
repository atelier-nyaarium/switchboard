// The holder's last status, held only while that holder holds.

import type { HoldAnswer } from "../../shared/assistant-hold.js";
import type { KeyAvailability } from "../../shared/schemasActionFront.js";
import {
	PHONE_CAPABILITIES,
	type PhoneCapabilityKey,
	type PhoneCapabilityResult,
} from "../../shared/schemasPhoneCapabilities.js";

export interface StatusMemo {
	note(key: PhoneCapabilityKey, result: PhoneCapabilityResult): void;
	read(): ReadonlyMap<string, KeyAvailability> | null;
}

export function createStatusMemo(hold: () => HoldAnswer): StatusMemo {
	let held: { holder: string; keys: Map<string, KeyAvailability> } | null = null;
	const holderNow = (): string | null => {
		try {
			const answer = hold();
			return answer.kind === "held" ? answer.holder : null;
		} catch {
			return null;
		}
	};
	return {
		note(key, result) {
			const holder = holderNow();
			if (!holder || (result.kind === "unavailable" && result.reason === "no_holder")) {
				held = null;
				return;
			}
			if (key === "status") {
				if (result.kind !== "ok") return;
				const parsed = PHONE_CAPABILITIES.status.answer.safeParse(result.answer);
				if (!parsed.success) return;
				if (parsed.data.holder === null) {
					held = null;
					return;
				}
				held = {
					holder,
					keys: new Map(
						parsed.data.keys.map((entry) => [
							entry.key,
							{ available: entry.available, ...(entry.reason ? { reason: entry.reason } : {}) },
						]),
					),
				};
				return;
			}
			if (!held || held.holder !== holder) return;
			if (result.kind === "ok") held.keys.set(key, { available: true });
			else if (result.kind === "unavailable") held.keys.set(key, { available: false, reason: result.reason });
		},
		read() {
			const holder = holderNow();
			return held && holder === held.holder ? held.keys : null;
		},
	};
}
