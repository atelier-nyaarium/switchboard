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

	it("judges a receipt again wherever it stands, and repeats its acknowledgement", () => {
		const ledger = new AgentFrameLedger<string>(8);
		const receipt = frame(0, { frame: "receipt" });
		const first = arrive(ledger, receipt);
		const ack = ledger.decide(first);
		ledger.decide(arrive(ledger, frame(1)));

		// Decided and not yet acknowledged, then acknowledged: placed by its operation each time.
		const again = arrive(ledger, receipt);
		expect(ledger.decide(again)).toMatchObject({ throughEventId: 1 });
		ledger.acknowledged({ ...ack!, throughEventId: 1 });
		const replayed = arrive(ledger, receipt);
		expect(ledger.decide(replayed)).toMatchObject({ throughEventId: 1 });
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

		const late = arrive(ledger, frame(4, { droppable: true }));
		expect(ledger.hold(late, "reconcile", 5).kept).toBe(false);
	});

	it("keeps a frame's first hold time across its retries, by reason", () => {
		const ledger = new AgentFrameLedger<string>(8);
		const placed = arrive(ledger, frame(0));
		const written = arrive(ledger, frame(1));
		ledger.hold(placed, "reconcile", 100);
		ledger.hold(written, "awaiting", 50);
		ledger.hold(placed, "failed", 900);

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
		// A frame with no stream leaves no decided mark.
		expect(ledger.receive(frame(7, { frame: "receipt", stream: undefined }), "again").kind).toBe("new");
	});

	it("keeps each daemon, target and generation a stream of its own", () => {
		const ledger = new AgentFrameLedger<string>(8);
		ledger.hold(arrive(ledger, frame(0)), "reconcile", 1);

		const other = arrive(ledger, frame(0, { daemonInstanceId: "d2" }));
		expect(ledger.decide(other)).toMatchObject({ daemonInstanceId: "d2", throughEventId: 0 });
		const elsewhere = arrive(ledger, frame(0, { stream: { targetId: "container:app", generation: 1 } }));
		expect(ledger.decide(elsewhere)).toMatchObject({ targetId: "container:app", throughEventId: 0 });
		const relaunched = arrive(ledger, frame(0, { stream: { targetId: "host", generation: 2 } }));
		expect(ledger.decide(relaunched)).toMatchObject({ generation: 2, throughEventId: 0 });
	});
});
