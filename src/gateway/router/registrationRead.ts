// A whole-state read at each registration: one in flight, an answer from an older registration dropped,
// and a failure retried while registered.

import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { fireAndForget } from "../fireAndForget.js";
import type { RouterClient, RouterToolCallResult } from "./routerClient.js";

export interface RegistrationReadDeps {
	label: string;
	ambient: Pick<Ambient, "setTimer" | "clearTimer">;
	retryMs: number;
	client: () => Pick<RouterClient, "incarnation" | "isRegistered">;
	call: () => Promise<RouterToolCallResult>;
	/** Lands a current answer: null, or why it could not. */
	apply: (answer: RouterToolCallResult) => Promise<string | null> | string | null;
}

export function createRegistrationRead(deps: RegistrationReadDeps) {
	let flight: Promise<void> | null = null;
	let retry: TimerHandle | null = null;
	let stopped = false;

	const read = (): Promise<void> => {
		if (flight) return flight;
		if (retry) deps.ambient.clearTimer(retry);
		retry = null;
		flight = (async () => {
			const asked = deps.client().incarnation();
			const answer = await deps.call();
			if (deps.client().incarnation() !== asked) return;
			let failure: string | null;
			try {
				failure = await deps.apply(answer);
			} catch (error) {
				failure = (error as Error).message;
			}
			if (failure === null || stopped) return;
			console.warn(`[federation] ${deps.label} failed: ${failure}`);
			if (deps.client().isRegistered())
				retry = deps.ambient.setTimer(() => fireAndForget(deps.label, read()), deps.retryMs);
		})().finally(() => {
			flight = null;
		});
		return flight;
	};

	return {
		read,
		stop: () => {
			stopped = true;
			if (retry) deps.ambient.clearTimer(retry);
			retry = null;
		},
	};
}
