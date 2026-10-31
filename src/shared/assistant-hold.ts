import { z } from "zod";
import { PHONE_HOLD_WINDOW_MS } from "./schemasPhoneHold.js";

export const ASSISTANT_HOLD_PATH = "/assistant/hold";

const holder = z.string().min(1).max(64);

export const HoldAnswerSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("held"),
		holder,
		label: holder,
		claimedAt: z.number().int().nonnegative(),
		remainingMs: z.number().int().nonnegative(),
	}),
	z.object({ kind: z.literal("lapsed"), holder, label: holder, lapsedMs: z.number().int().nonnegative() }),
	/** No hold claimed. */
	z.object({ kind: z.literal("none") }),
	z.object({ kind: z.literal("not_assistant") }),
	z.object({ kind: z.literal("unauthenticated") }),
]);

export type HoldAnswer = z.infer<typeof HoldAnswerSchema>;

/** Hold read failed. */
export type HoldUnreadable = { kind: "unreadable"; reason: string };

export type HoldDenial = Exclude<HoldAnswer, { kind: "held" }> | HoldUnreadable;

export const HOLD_REBIND_LINE = "Send me a message from the summon panel or the Assistant tab, then ask me again.";

function minutes(ms: number): string {
	const whole = Math.max(1, Math.round(ms / 60_000));
	return `${whole} minute${whole === 1 ? "" : "s"}`;
}

export function holdDenial(denial: HoldDenial): string {
	switch (denial.kind) {
		case "lapsed":
			return `Your phone's hold lapsed ${minutes(denial.lapsedMs)} ago (last held by your ${denial.label}). I can't write files or act on your phone until you hold me again. ${HOLD_REBIND_LINE}`;
		case "none":
			return `No phone holds me right now, so I can't write files or act on your phone. ${HOLD_REBIND_LINE}`;
		case "unreadable":
			return `I could not read the hold from the Gateway (${denial.reason}), so writes stay refused. The Gateway may need a restart.`;
		case "not_assistant":
			return "Only the assistant's session reads the hold.";
		case "unauthenticated":
			return "This session presented no token, so the hold refused it.";
	}
}

export function holdWindowMinutes(): number {
	return PHONE_HOLD_WINDOW_MS / 60_000;
}
