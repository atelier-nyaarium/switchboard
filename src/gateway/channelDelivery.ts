import { fenced, MIGRATING } from "../shared/migration-fence.js";
import type { PendingDelivery, PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import { reached, sendOn } from "./wsSend.js";
import { getAllActiveWs, type TeamRegistry } from "./wsTypes.js";

////////////////////////////////
//  Interfaces & Types

/** What became of a message handed to [ChannelDeliveryCoordinator.accept]. All three are answers the
 * sender can act on; none of them loses the message silently. */
export type AcceptOutcome = "delivered" | "queued" | "refused" | "migrating";

export interface ChannelDeliveryDeps {
	store: PendingDeliveryStore;
	registry: TeamRegistry;
	/** Nudges an unconfirmed recipient's handshake ahead of the message, so its reply does not burn a
	 * turn on the reply gate. */
	repushHandshake?: (team: string, subId: string) => unknown;
	/** Retired delivery bytes. */
	retireStaging?: (blobIds: string[]) => void;
}

const blobIdsOf = (deliveries: readonly PendingDelivery[]): string[] => [
	...new Set(
		deliveries.flatMap((delivery) => (delivery.files ?? []).flatMap((file) => (file.blobId ? [file.blobId] : []))),
	),
];

////////////////////////////////
//  Class

/**
 * The one road a channel message travels, whether its session was ready or not.
 *
 * Acceptance is a promise: once this says `delivered` or `queued`, the message is either with the
 * session or on disk waiting for it. It is retired only when the receiver says it emitted the
 * notification - a socket write proves the bytes left, not that anything read them.
 */
export class ChannelDeliveryCoordinator {
	constructor(private readonly deps: ChannelDeliveryDeps) {}

	/** Deliver now if the session can take it, hold it if not. */
	accept(delivery: PendingDelivery): AcceptOutcome {
		const outcome = this.deps.store.enqueue(delivery);
		if (outcome === "migrating") return "migrating";
		if (outcome === "refused") return "refused";
		// A duplicate is already held; offering it again is what a retry of a lost reply wants.
		const offered = this.offer(delivery);
		return offered === MIGRATING ? MIGRATING : offered ? "delivered" : "queued";
	}

	/** Hand everything waiting for a team to it, oldest first. Returns how many were offered. */
	drain(team: string): number | "migrating" {
		if (fenced()) return MIGRATING;
		let offered = 0;
		for (const delivery of this.deps.store.listForTeam(team)) {
			const result = this.offer(delivery);
			if (result === MIGRATING) return MIGRATING;
			if (result) offered++;
		}
		return offered;
	}

	/** The receiver confirmed it emitted this one. */
	acknowledge(deliveryId: string): boolean | "migrating" {
		const held = this.deps.store.snapshot().deliveries.find((delivery) => delivery.deliveryId === deliveryId);
		const retired = this.deps.store.acknowledge(deliveryId);
		if (retired === true && held) this.deps.retireStaging?.(blobIdsOf([held]));
		return retired;
	}

	/** Drops expired delivery staging. */
	sweep(): number {
		const expired = this.deps.store.sweep();
		if (expired === MIGRATING) return 0;
		if (expired.length) this.deps.retireStaging?.(blobIdsOf(expired));
		return expired.length;
	}

	/** Held message names bytes. */
	namesBlob(blobId: string): boolean {
		return this.deps.store
			.snapshot()
			.deliveries.some((delivery) => delivery.files?.some((file) => file.blobId === blobId));
	}

	/**
	 * Write one delivery to every live socket for its team.
	 *
	 * False when nothing took it, which leaves the row queued for the next drain.
	 */
	private offer(delivery: PendingDelivery): boolean | typeof MIGRATING {
		const subs = this.deps.registry.get(delivery.team);
		const sockets = subs ? getAllActiveWs(subs) : [];
		if (sockets.length === 0) return false;

		const payload = JSON.stringify(channelPushPayload(delivery));
		let took = false;
		for (const ws of sockets) {
			if (!ws.data.handshakeConfirmed && ws.data.teamName) {
				this.deps.repushHandshake?.(ws.data.teamName, ws.data.subId);
			}
			if (reached(sendOn(ws, payload, `channel_push to ${delivery.team}`))) took = true;
		}
		return took;
	}
}

////////////////////////////////
//  Functions & Helpers

/** The wire shape, built from the stored row rather than from live state, so a message delivered
 * after a restart is byte-for-byte the one that was accepted. */
export function channelPushPayload(delivery: PendingDelivery): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		type: "channel_push",
		from: delivery.from,
		body: delivery.body,
		session_id: delivery.channelJobId,
		delivery_id: delivery.deliveryId,
	};
	if (delivery.messageId) payload.message_id = delivery.messageId;
	if (delivery.files && delivery.files.length > 0) payload.files = delivery.files;
	if (delivery.awareness) payload.awareness = delivery.awareness;
	if (delivery.disposition) payload.disposition = delivery.disposition;
	return payload;
}
