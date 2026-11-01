import type { HoldAnswer } from "../../shared/assistant-hold.js";
import { holdStanding, PHONE_HOLD_WINDOW_MS, type PhoneHoldRecord } from "../../shared/schemasPhoneHold.js";

export function createHoldFollow(now: () => number) {
	let hold: PhoneHoldRecord | null = null;
	let swept = false;
	let revision = 0;

	const apply = (record: PhoneHoldRecord | null): void => {
		if (record === null) {
			if (hold !== null) swept = true;
		} else {
			hold = record;
			swept = false;
		}
		revision += 1;
	};

	const answer = (): HoldAnswer => {
		if (hold === null) return { kind: "none" };
		const current = now();
		const elapsed = Math.max(0, current - hold.claimedAt);
		if (!swept && holdStanding(hold, current) === "held") {
			return {
				kind: "held",
				holder: hold.holder,
				label: hold.label,
				claimedAt: hold.claimedAt,
				remainingMs: Math.max(0, PHONE_HOLD_WINDOW_MS - elapsed),
			};
		}
		return {
			kind: "lapsed",
			holder: hold.holder,
			label: hold.label,
			lapsedMs: Math.max(0, elapsed - PHONE_HOLD_WINDOW_MS),
		};
	};

	return {
		apply,
		answer,
		hold: () => hold,
		revision: () => revision,
	};
}

export type HoldFollow = ReturnType<typeof createHoldFollow>;
