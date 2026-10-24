import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { ChannelDeliveryCoordinator } from "../gateway/channelDelivery.js";
import type { TeamRegistry, WsData } from "../gateway/wsTypes.js";
import { processAmbient } from "../shared/ambient.js";
import { type MessageDelivery, type PendingDelivery, PendingDeliveryStore } from "../shared/pending-delivery-store.js";

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

function delivery(id: string): MessageDelivery {
	return {
		deliveryId: id,
		team: "proj.alpha",
		channelJobId: "job-1",
		from: "pixel",
		body: "hi",
		enqueuedAt: 1_000,
	};
}

const NOOP_OBSERVER = { offered: () => undefined, acknowledged: () => undefined };

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
			observer: NOOP_OBSERVER,
		});
		const named = (id: string, blobId: string): MessageDelivery => ({
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
		const c = new ChannelDeliveryCoordinator({ store, registry: new Map(), observer: NOOP_OBSERVER });
		expect(c.accept(delivery("d1"))).toBe("queued");
		expect(store.listForTeam("proj.alpha")).toHaveLength(1);
	});

	it("offers the held row when a duplicate is accepted", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const registry: TeamRegistry = new Map();
		const s = socket();
		const offered: PendingDelivery[] = [];
		const c = new ChannelDeliveryCoordinator({
			store,
			registry,
			observer: { offered: (row) => offered.push(row), acknowledged: () => undefined },
		});
		const original: MessageDelivery = { ...delivery("d1"), body: "accepted", origin: "owner" };

		expect(c.accept(original)).toBe("queued");
		registry.set("proj.alpha", new Map([["s1", s.ws]]));
		expect(c.accept({ ...original, body: "retry", origin: "event", seq: 99 })).toBe("delivered");

		expect(offered).toHaveLength(1);
		expect(offered[0]).toMatchObject({ body: "accepted", seq: 1, origin: "owner" });
		expect(JSON.parse(s.sent[0])).toMatchObject({ body: "accepted", delivery_id: "d1" });
	});

	it("delivers to a live session and keeps the row until that session says it landed", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const s = socket();
		const c = new ChannelDeliveryCoordinator({ store, registry: registryWith(s), observer: NOOP_OBSERVER });

		expect(c.accept(delivery("d1"))).toBe("delivered");
		expect(s.sent).toHaveLength(1);
		// Only acknowledgement retires a held delivery.
		expect(store.listForTeam("proj.alpha")).toHaveLength(1);

		expect(c.acknowledge("d1", "proj.other")).toBe(false);
		expect(store.listForTeam("proj.alpha")).toHaveLength(1);
		expect(c.acknowledge("d1", "proj.alpha")).toBe(true);
		expect(store.listForTeam("proj.alpha")).toHaveLength(0);
	});

	it("carries the delivery id on the wire, since that is what the receiver acknowledges", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const s = socket();
		new ChannelDeliveryCoordinator({ store, registry: registryWith(s), observer: NOOP_OBSERVER }).accept(
			delivery("d1"),
		);
		expect(JSON.parse(s.sent[0])).toMatchObject({ type: "channel_push", delivery_id: "d1", session_id: "job-1" });
	});

	it("hands a session everything it missed when it finally arrives, oldest first", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const registry: TeamRegistry = new Map();
		const c = new ChannelDeliveryCoordinator({ store, registry, observer: NOOP_OBSERVER });

		c.accept(delivery("d1"));
		c.accept(delivery("d2"));
		expect(store.listForTeam("proj.alpha")).toHaveLength(2);

		const s = socket();
		registry.set("proj.alpha", new Map([["s0", s.ws]]));
		expect(c.drain("proj.alpha")).toBe(2);
		expect(s.sent.map((p) => JSON.parse(p).delivery_id)).toEqual(["d1", "d2"]);
	});

	it("keeps a held event an event across a restart, and refuses a message reusing its id", () => {
		let saved: unknown = null;
		const sink = { load: () => saved, saveChecked: (state: unknown) => (saved = structuredClone(state)) };
		const held = new PendingDeliveryStore(sink, processAmbient());
		const queued = new ChannelDeliveryCoordinator({ store: held, registry: new Map(), observer: NOOP_OBSERVER });
		queued.accept({ deliveryId: "e1", team: "proj.alpha", body: "hi", enqueuedAt: 1_000, event: true });
		const shadow = queued.accept(delivery("e1"));

		const s = socket();
		const reopened = new ChannelDeliveryCoordinator({
			store: new PendingDeliveryStore(sink, processAmbient()),
			registry: registryWith(s),
			observer: NOOP_OBSERVER,
		});
		reopened.drain("proj.alpha");

		expect(shadow).toBe("refused");
		expect(s.sent.map((p) => JSON.parse(p))).toEqual([
			{ type: "channel_push", event: true, from: "", session_id: "", body: "hi", delivery_id: "e1" },
		]);
	});

	it("offers each event member once, held or read, across a restart, until it ages out", () => {
		let now = 10_000;
		let saved: unknown = null;
		const sink = { load: () => saved, saveChecked: (state: unknown) => (saved = structuredClone(state)) };
		const member = (key: string) => ({ key, text: key });
		const event = (c: ChannelDeliveryCoordinator, ...keys: string[]) =>
			c.acceptEvent({ team: "proj.alpha", members: keys.map(member), enqueuedAt: now });
		const s = socket();
		const c = new ChannelDeliveryCoordinator({
			store: new PendingDeliveryStore(sink, { now: () => now }, 5_000),
			registry: registryWith(s),
			observer: NOOP_OBSERVER,
		});

		const first = event(c, "a", "b");
		const repeat = event(c, "a", "b");
		const overlap = event(c, "b", "c");
		const bodies = s.sent.map((p) => JSON.parse(p).body);
		for (const id of s.sent.map((p) => JSON.parse(p).delivery_id)) c.acknowledge(id);
		const reopened = new ChannelDeliveryCoordinator({
			store: new PendingDeliveryStore(sink, { now: () => now }, 5_000),
			registry: registryWith(s),
			observer: NOOP_OBSERVER,
		});
		const afterRead = event(reopened, "a", "c");
		now += 5_001;
		reopened.sweep();
		const aged = event(reopened, "a");

		expect([first, repeat, overlap, afterRead, aged]).toEqual([
			"delivered",
			"seen",
			"delivered",
			"seen",
			"delivered",
		]);
		expect(bodies).toEqual([`a${"\n\n"}b`, "c"]);
	});

	it("re-offers an unacknowledged message on the next drain, so a lost notification is not a loss", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient());
		const s = socket();
		const c = new ChannelDeliveryCoordinator({ store, registry: registryWith(s), observer: NOOP_OBSERVER });

		c.accept(delivery("d1"));
		expect(c.drain("proj.alpha")).toBe(1);
		expect(s.sent).toHaveLength(2);
	});

	it("refuses rather than accepting a message it cannot hold", () => {
		const store = new PendingDeliveryStore(undefined, processAmbient(), undefined, 1);
		const c = new ChannelDeliveryCoordinator({ store, registry: new Map(), observer: NOOP_OBSERVER });
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
			observer: NOOP_OBSERVER,
			repushHandshake: (team) => nudged.push(team),
		});
		c.accept(delivery("d1"));
		expect(nudged).toEqual(["proj.alpha"]);
	});
});
