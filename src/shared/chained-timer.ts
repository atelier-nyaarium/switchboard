import type { Ambient, TimerHandle } from "./ambient.js";

/** Past this a platform timer fires immediately instead of waiting. */
const MAX_TIMER_MS = 2_147_483_647;

export type ChainTimers = Pick<Ambient, "setTimer" | "clearTimer">;

/** Re-arms past the platform's timer ceiling. */
export function chainedTimer(ambient: ChainTimers, delayMs: number, fn: () => void): { handle: () => TimerHandle } {
	let current: TimerHandle;
	const arm = (remaining: number) => {
		current = ambient.setTimer(
			() => (remaining > MAX_TIMER_MS ? arm(remaining - MAX_TIMER_MS) : fn()),
			Math.min(remaining, MAX_TIMER_MS),
		);
	};
	arm(delayMs);
	return { handle: () => current };
}
