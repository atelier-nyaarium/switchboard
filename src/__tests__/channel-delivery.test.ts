import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { ChannelDeliveryCoordinator } from "../gateway/channelDelivery.js";
import type { TeamRegistry, WsData } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import { type PendingDelivery, PendingDeliveryStore } from "../shared/pending-delivery-store.js";

interface FakeSocket {
	sent: string[];
	ws: ServerWebSocket<WsData>;
}

function socket(): FakeSocket {
	const sent: string[] = [];
	const ws = {
		readyState: 1,
		send: (payload: string) => sent.push(payload),
		data: {
			teamName: "proj.alpha",
			subId: "s1",
			conversationId: null,
			mode: "channel",
			missedPings: 0,
			isStale: false,
			handshakeConfirmed: true,
		} as WsData,
	} as unknown as ServerWebSocket<WsData>;
	return { sent, ws };
}

function registryWith(...sockets: FakeSocket[]): TeamRegistry {
	const subs = new Map<string, ServerWebSocket<WsData>>();
	for (const [i, s] of sockets.entries()) subs.set(`s${i}`, s.ws);
	return new Map([["proj.alpha", subs]]);
}

function delivery(id: string): PendingDelivery {
	return {
		deliveryId: id,
		team: "proj.alpha",
		channelJobId: "job-1",
		from: "pixel",
		body: "hi",
		enqueuedAt: 1_000,
	};
}

describe("ChannelDeliveryCoordinator", () => {
	it("lets go of the bytes a message named once it is acknowledged, or once it expires unread", () => {
		let now = 10_000;
		const store = new PendingDeliveryStore(undefined, { now: () => now }, 5_000);
		const retired: string[][] = [];
		const s = socket();
		const c = new ChannelDeliveryCoordinator({
			store,
			registry: registryWith(s),
			retireStaging: (blobIds) => retired.push(blobIds),
		});
		const named = (id: string, blobId: string): PendingDelivery => ({
			...delivery(id),
			enqueuedAt: now,
			files: [{ filename: "a.png", mime: "image/png", size: 1, descriptiveKey: "a", role: "attachment", blobId }],
		});

		expect(c.accept(named("d1", "sha256-a"))).toBe("delivered");
		expect(c.acknowledge("d1")).toBe(true);
		expect(retired).toEqual([["sha256-a"]]);

		expect(c.accept(named("d2", "sha256-b"))).toBe("delivered");
		now += 4_999;
		expect(c.sweep()).toBe(0);
		now += 2;
		expect(c.sweep()).toBe(1);
		expect(retired).toEqual([["sha256-a"], ["sha256-b"]]);
		expect(store.listForTeam("proj.alpha")).toHaveLength(0);
	});

	it("holds a message when nothing is listening, instead of losing it", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const c = new ChannelDeliveryCoordinator({ store, registry: new Map() });
		expect(c.accept(delivery("d1"))).toBe("queued");
		expect(store.listForTeam("proj.alpha")).toHaveLength(1);
	});

	it("delivers to a live session and keeps the row until that session says it landed", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const s = socket();
		const c = new ChannelDeliveryCoordinator({ store, registry: registryWith(s) });

		expect(c.accept(delivery("d1"))).toBe("delivered");
		expect(s.sent).toHaveLength(1);
		// Only acknowledgement retires a held delivery.
		expect(store.listForTeam("proj.alpha")).toHaveLength(1);

		expect(c.acknowledge("d1")).toBe(true);
		expect(store.listForTeam("proj.alpha")).toHaveLength(0);
	});

	it("carries the delivery id on the wire, since that is what the receiver acknowledges", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const s = socket();
		new ChannelDeliveryCoordinator({ store, registry: registryWith(s) }).accept(delivery("d1"));
		expect(JSON.parse(s.sent[0])).toMatchObject({ type: "channel_push", delivery_id: "d1", session_id: "job-1" });
	});

	it("hands a session everything it missed when it finally arrives, oldest first", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const registry: TeamRegistry = new Map();
		const c = new ChannelDeliveryCoordinator({ store, registry });

		c.accept(delivery("d1"));
		c.accept(delivery("d2"));
		expect(store.listForTeam("proj.alpha")).toHaveLength(2);

		const s = socket();
		registry.set("proj.alpha", new Map([["s0", s.ws]]));
		expect(c.drain("proj.alpha")).toBe(2);
		expect(s.sent.map((p) => JSON.parse(p).delivery_id)).toEqual(["d1", "d2"]);
	});

	it("re-offers an unacknowledged message on the next drain, so a lost notification is not a loss", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const s = socket();
		const c = new ChannelDeliveryCoordinator({ store, registry: registryWith(s) });

		c.accept(delivery("d1"));
		expect(c.drain("proj.alpha")).toBe(1);
		expect(s.sent).toHaveLength(2);
	});

	it("refuses rather than accepting a message it cannot hold", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient(), undefined, 1);
		const c = new ChannelDeliveryCoordinator({ store, registry: new Map() });
		expect(c.accept(delivery("d1"))).toBe("queued");
		expect(c.accept(delivery("d2"))).toBe("refused");
	});

	it("nudges an unconfirmed recipient's handshake ahead of the message", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const s = socket();
		s.ws.data.handshakeConfirmed = false;
		const nudged: string[] = [];
		const c = new ChannelDeliveryCoordinator({
			store,
			registry: registryWith(s),
			repushHandshake: (team) => nudged.push(team),
		});
		c.accept(delivery("d1"));
		expect(nudged).toEqual(["proj.alpha"]);
	});
});
