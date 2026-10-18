// Wakes the assistant for wake-sorted inbox rows. The inbox decides; the delivery queue applies.

import { createHash } from "node:crypto";
import type { Ambient, TimerHandle } from "../../shared/ambient.js";
import { fireAndForget } from "../fireAndForget.js";
import type { InboxEvent, InboxStore } from "./inboxStore.js";

/** Events one wake carries. */
export const WAKE_BATCH = 20;
export const WAKE_RETRY_MS = 30_000;
export const WAKE_RETRY_MAX_MS = 15 * 60_000;

/**
 * The send path's senderless event. `compose` runs once the session is reached, just before the
 * queue takes it; null means nothing is left to send. Null when it landed or there was nothing,
 * else why not.
 */
export type AssistantWake = (event: {
	to: string;
	compose: () => { deliveryId: string; body: string } | null;
}) => Promise<string | null>;

export interface WakeRunnerDeps {
	ambient: Pick<Ambient, "now" | "setTimer" | "clearTimer">;
	inbox: Pick<InboxStore, "pendingWakes" | "markWoken">;
	to: string;
	/** Whether the assistant lives here and federation is active. */
	ready: () => boolean;
	render: (batch: readonly InboxEvent[]) => string;
}

export interface WakeRunner {
	/** The send path, bound on each federation activation. */
	bind: (wake: AssistantWake) => void;
	/** Wakes for what is pending; a nudge during a round runs another. */
	nudge: () => void;
	/** Final. Answers once a wake in flight settles. */
	stop: () => Promise<void>;
}

export function createWakeRunner(deps: WakeRunnerDeps): WakeRunner {
	const { ambient, inbox } = deps;
	let wake: AssistantWake | null = null;
	let closed = false;
	let waking: Promise<void> | null = null;
	let again = false;
	let retryTimer: TimerHandle | null = null;
	let retryMs = WAKE_RETRY_MS;

	const retryLater = (why: string) => {
		console.warn(`[assistant] wake not delivered; retrying in ${retryMs / 1000}s: ${why}`);
		if (retryTimer || closed) return;
		retryTimer = ambient.setTimer(() => {
			retryTimer = null;
			nudge();
		}, retryMs);
		retryMs = Math.min(retryMs * 2, WAKE_RETRY_MAX_MS);
	};
	const settleRetry = () => {
		if (retryTimer) ambient.clearTimer(retryTimer);
		retryTimer = null;
		retryMs = WAKE_RETRY_MS;
	};

	const round = async (): Promise<void> => {
		do {
			again = false;
			while (true) {
				if (!wake || closed || !deps.ready()) return;
				if (inbox.pendingWakes(ambient.now()).length === 0) break;
				let batch: InboxEvent[] = [];
				let failed: string | null;
				try {
					failed = await wake({
						to: deps.to,
						// Read once reached, so a row read meanwhile is not pushed.
						compose: () => {
							batch = inbox.pendingWakes(ambient.now()).slice(0, WAKE_BATCH);
							return batch.length === 0
								? null
								: { deliveryId: wakeDeliveryId(batch), body: deps.render(batch) };
						},
					});
				} catch (error) {
					failed = (error as Error).message;
				}
				if (failed) return retryLater(failed);
				// Final; next start re-offers.
				if (closed) return;
				if (batch.length > 0 && !inbox.markWoken(batch, ambient.now()))
					return retryLater("the inbox write did not land");
			}
		} while (again);
		settleRetry();
	};

	// Start, placement and bind nudge again once ready.
	const nudge = (): void => {
		if (closed || !deps.ready()) return;
		if (waking) {
			again = true;
			return;
		}
		waking = round().finally(() => {
			waking = null;
		});
		fireAndForget("assistant wake", waking);
	};

	return {
		bind: (bound) => {
			wake = bound;
			nudge();
		},
		nudge,
		stop: async () => {
			closed = true;
			if (retryTimer) ambient.clearTimer(retryTimer);
			retryTimer = null;
			await waking;
		},
	};
}

/** Derived from the batch, so a wake tried again is the same delivery. */
export function wakeDeliveryId(batch: readonly Pick<InboxEvent, "watcherId" | "sourceId">[]): string {
	const hash = createHash("sha256");
	for (const event of batch) hash.update(`${event.watcherId}\u0000${event.sourceId}\u0000`);
	return `assistant-event:${hash.digest("hex").slice(0, 32)}`;
}
