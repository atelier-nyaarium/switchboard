import { describe, expect, it } from "vitest";
import { createChannelPushDelivery } from "../mcp/bridge/channelPushDelivery.js";
import type { ChannelPushPayload } from "../shared/types.js";

const message: ChannelPushPayload = {
	type: "channel_push",
	from: "phone",
	body: "hi",
	session_id: "conv.1",
	delivery_id: "d-message",
};
const event: ChannelPushPayload = {
	type: "channel_push",
	event: true,
	from: "",
	body: "watcher event",
	session_id: "",
	delivery_id: "d-event",
};

function harness({ failFirst = false, maxRemembered = 10 } = {}) {
	const emitted: ChannelPushPayload[] = [];
	const acked: string[] = [];
	let failing = failFirst;
	const deliver = createChannelPushDelivery({
		emit: async (push) => {
			if (failing) {
				failing = false;
				throw new Error("transport closed");
			}
			emitted.push(push);
		},
		ack: (deliveryId) => acked.push(deliveryId),
		maxRemembered,
	});
	return { deliver, emitted, acked };
}

describe("channel push delivery", () => {
	it.each([
		["message", message],
		["event", event],
	])("emits a %s once, as offered, when a lost ack brings it back, and acks both offers", async (_kind, push) => {
		const { deliver, emitted, acked } = harness();

		await deliver(push);
		await deliver(push);

		expect(emitted).toEqual([push]);
		expect(acked).toEqual([push.delivery_id, push.delivery_id]);
	});

	it("retries an emit that failed, and acks only the one that landed", async () => {
		const { deliver, emitted, acked } = harness({ failFirst: true });

		await expect(deliver(message)).rejects.toThrow("transport closed");
		await deliver(message);

		expect(emitted).toEqual([message]);
		expect(acked).toEqual(["d-message"]);
	});

	it("holds a concurrent repeat's ack until the first emit lands, then emits once", async () => {
		const emitted: ChannelPushPayload[] = [];
		const acked: string[] = [];
		let land = () => {};
		const landed = new Promise<void>((resolve) => {
			land = resolve;
		});
		const deliver = createChannelPushDelivery({
			emit: async (push) => {
				await landed;
				emitted.push(push);
			},
			ack: (deliveryId) => acked.push(deliveryId),
			maxRemembered: 10,
		});

		const offers = Promise.all([deliver(message), deliver(message), deliver(message)]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(acked).toEqual([]);

		land();
		await offers;
		expect(emitted).toEqual([message]);
		expect(acked).toEqual(["d-message", "d-message", "d-message"]);
	});

	it("emits a push without a usable id every time, and acks none", async () => {
		const { deliver, emitted, acked } = harness();
		const { delivery_id: _id, ...unstored } = message;
		const malformed = { ...message, delivery_id: 7 } as unknown as ChannelPushPayload;

		await deliver(unstored);
		await deliver(unstored);
		await deliver(malformed);

		expect(emitted).toHaveLength(3);
		expect(acked).toEqual([]);
	});

	it("forgets the oldest ids past its bound, so one of those emits again", async () => {
		const { deliver, emitted } = harness({ maxRemembered: 2 });
		const offer = (id: string) => deliver({ ...message, delivery_id: id });

		for (const id of ["a", "b", "c"]) await offer(id);
		await offer("c");
		await offer("a");

		expect(emitted.map((push) => push.delivery_id)).toEqual(["a", "b", "c", "a"]);
	});
});
