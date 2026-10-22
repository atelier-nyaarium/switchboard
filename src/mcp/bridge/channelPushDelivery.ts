import { capFifo } from "../../shared/cap-fifo.js";
import { createKeyedFifo } from "../../shared/keyed-fifo.js";
import type { ChannelPushPayload } from "../../shared/types.js";

export interface ChannelPushDeliveryDeps {
	emit: (push: ChannelPushPayload) => Promise<void>;
	ack: (deliveryId: string) => void;
	maxRemembered: number;
}

/**
 * Emits before ack. Repeats are acked without emitting. Failed emits remain retryable.
 */
export function createChannelPushDelivery(deps: ChannelPushDeliveryDeps): (push: ChannelPushPayload) => Promise<void> {
	const emitted = new Set<string>();
	const repeats = createKeyedFifo<string>();
	return async (push) => {
		// Unvalidated wire value.
		const deliveryId = typeof push.delivery_id === "string" ? push.delivery_id : undefined;
		if (deliveryId === undefined) {
			await deps.emit(push);
			return;
		}
		await repeats.run(deliveryId, async () => {
			if (!emitted.has(deliveryId)) {
				await deps.emit(push);
				emitted.add(deliveryId);
				capFifo(emitted, deps.maxRemembered);
			}
			deps.ack(deliveryId);
		});
	};
}
