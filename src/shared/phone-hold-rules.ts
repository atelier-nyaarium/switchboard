import { holdStanding, PHONE_HOLD_WINDOW_MS, type PhoneHoldRecord } from "./schemasPhoneHold.js";

export type HoldView = Pick<PhoneHoldRecord, "holder" | "claimedAt"> | null;

export interface HoldDecisionInput {
	hold: HoldView;
	/** This phone's id. */
	self: string;
	now: number;
	/** Unheld default behavior. */
	todayRule: boolean;
	windowMs?: number;
}

/** Only the holder speaks. */
export function speaksFor(input: HoldDecisionInput): boolean {
	const standing = holdStanding(input.hold, input.now, input.windowMs ?? PHONE_HOLD_WINDOW_MS);
	if (standing !== "held" || input.hold === null) return input.todayRule;
	return input.hold.holder === input.self;
}

export function alertsFor(input: HoldDecisionInput & { visible: boolean }): boolean {
	const standing = holdStanding(input.hold, input.now, input.windowMs ?? PHONE_HOLD_WINDOW_MS);
	if (standing !== "held" || input.hold === null) return input.todayRule;
	return input.hold.holder === input.self && !input.visible;
}
