import { describe, expect, it } from "vitest";
import { AgentFrameLedger, type FrameIdentity, type FrameTicket } from "../gateway/agentFrameLedger.js";

const STREAM = { targetId: "host", generation: 1 };

function frame(eventId: number, over: Partial<FrameIdentity> = {}): FrameIdentity {
	return { frame: "event", agent: "a", daemonInstanceId: "d1", eventId, stream: STREAM, droppable: false, ...over };
}

function arrive(ledger: AgentFrameLedger<string>, identity: FrameIdentity): FrameTicket<string> {
	const arrival = ledger.receive(identity, `payload ${identity.eventId}`);
	if (arrival.kind !== "new") throw new Error(`expected a new frame, got ${arrival.kind}`);
	return arrival.ticket;
}

describe("AgentFrameLedger", () => {
	it("never acknowledges past a frame that arrived and is not decided", () => {
		const ledger = new AgentFrameLedger<string>(8);
		const first = arrive(ledger, frame(0, { agent: "slow" }));
		const second = arrive(ledger, frame(1, { agent: "fast" }));

		// The later frame's reducer ran first.
		expect(ledger.decide(second)).toBeUndefined();
		expect(ledger.decide(first)).toMatchObject({ throughEventId: 1 });
	});

	it("holds the acknowledgement at a held frame and frees it through the highest decided once it is decided", () => {
		const ledger = new AgentFrameLedger<string>(8);
		const held = arrive(ledger, frame(0));
		expect(ledger.hold(held, "reconcile", 10)).toEqual({ kept: true, acks: [] });
		expect(ledger.decide(arrive(ledger, frame(1)))).toBeUndefined();
		expect(ledger.decide(arrive(ledger, frame(2)))).toBeUndefined();

		expect(ledger.decide(held)).toEqual({ daemonInstanceId: "d1", ...STREAM, throughEventId: 2 });
		expect(ledger.holds("a")).toBe(false);
	});

	it("tells a replay by where its first copy stands", () => {
		const ledger = new AgentFrameLedger<string>(8);
		const done = arrive(ledger, frame(0));
		const ack = ledger.decide(done);
		const waiting = arrive(ledger, frame(1));
		ledger.hold(waiting, "reconcile", 10);
		arrive(ledger, frame(2));
		const blocked = arrive(ledger, frame(3));
		ledger.decide(blocked);

		// An acknowledgement that was never sent, then one that was sent and lost.
		expect(ledger.receive(frame(0), "again")).toEqual({ kind: "decided", ack });
		ledger.acknowledged(ack!);
		expect(ledger.receive(frame(0), "again")).toEqual({ kind: "decided", ack });
		expect(ledger.receive(frame(1), "again")).toEqual({ kind: "held", ticket: waiting });
		expect(ledger.receive(frame(2), "again")).toEqual({ kind: "queued" });
		// Decided above a held frame: no acknowledgement can name it yet.
		expect(ledger.receive(frame(3), "again")).toEqual({ kind: "decided" });
	});

	it("drops only commentary from a full hold, and what it drops is decided", () => {
		const ledger = new AgentFrameLedger<string>(2);
		const outcome = arrive(ledger, frame(0));
		const chatter = arrive(ledger, frame(1, { droppable: true }));
		const later = arrive(ledger, frame(2));
		ledger.hold(outcome, "reconcile", 1);
		ledger.hold(chatter, "reconcile", 2);

		expect(ledger.hold(later, "reconcile", 3).kept).toBe(true);
		expect(chatter.state).toBe("decided");
		expect(ledger.heldFor("a")).toEqual([outcome, later]);

		// Outcomes alone stay past the cap.
		const more = arrive(ledger, frame(3));
		expect(ledger.hold(more, "failed", 4).kept).toBe(true);
		expect(ledger.heldFor("a")).toHaveLength(3);

		// A dropped arrival is not kept.
		const late = arrive(ledger, frame(4, { droppable: true }));
		expect(ledger.hold(late, "reconcile", 5).kept).toBe(false);
	});

	it("keeps a frame's first hold time and counted mark across its retries, by reason", () => {
		const ledger = new AgentFrameLedger<string>(8);
		const placed = arrive(ledger, frame(0));
		const written = arrive(ledger, frame(1));
		ledger.hold(placed, "reconcile", 100);
		placed.counted = true;
		ledger.hold(written, "awaiting", 50);
		// A retry holds it again.
		ledger.hold(placed, "failed", 900);

		expect(placed.counted).toBe(true);
		expect(ledger.heldSince("a", ["reconcile", "failed"])).toBe(100);
		expect(ledger.heldSince("a", ["awaiting"])).toBe(50);
		expect(ledger.heldSince("other", ["reconcile"])).toBeUndefined();
		expect(ledger.heldFor("a")).toEqual([placed, written]);
		expect(ledger.heldAgents()).toEqual(["a"]);
	});

	it("holds and decides a frame that names no stream", () => {
		const ledger = new AgentFrameLedger<string>(8);
		const refusal = arrive(ledger, frame(7, { frame: "receipt", stream: undefined }));
		ledger.hold(refusal, "failed", 1);

		expect(ledger.receive(frame(7, { frame: "receipt", stream: undefined }), "again")).toEqual({
			kind: "held",
			ticket: refusal,
		});
		expect(ledger.decide(refusal)).toBeUndefined();
		expect(ledger.holds("a")).toBe(false);
		// Nothing remembers a decided one.
		expect(ledger.receive(frame(7, { frame: "receipt", stream: undefined }), "again").kind).toBe("new");
	});

	it("keeps each daemon's streams apart", () => {
		const ledger = new AgentFrameLedger<string>(8);
		ledger.hold(arrive(ledger, frame(0)), "reconcile", 1);

		const other = arrive(ledger, frame(0, { daemonInstanceId: "d2" }));
		expect(ledger.decide(other)).toMatchObject({ daemonInstanceId: "d2", throughEventId: 0 });
	});
});
