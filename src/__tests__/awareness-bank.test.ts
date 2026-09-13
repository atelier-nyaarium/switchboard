import { describe, expect, it } from "vitest";
import {
	type AwarenessBank,
	createAwarenessBank,
	isNoAckSessionId,
	MAX_AWARENESS_BODY_CHARS,
	MAX_HOLD_MS,
} from "../gateway/awarenessBank.js";
import { processAmbient } from "../shared/ambient.js";
import type { ChannelPushPayload } from "../shared/types.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

function take(bank: AwarenessBank, sessionKey: string) {
	const lease = bank.prepareFor(sessionKey);
	lease?.commit();
	return lease?.awareness ?? null;
}

describe("awareness bank", () => {
	it("keeps what a refused carrier held, and after an accepted one keeps only what changed since", () => {
		const bank = createAwarenessBank({ liveness: () => "live", deliver: () => true, ambient: processAmbient() });
		const observe = bank.register<string>({
			source: "fake",
			act: () => "no_act",
			render: (_s, changes) => changes.map((c) => `${c.identity}:${c.pre}->${c.post}`).join(","),
		});
		observe([{ sessionKey: "s", identity: "x", pre: "a", post: "b" }]);

		bank.prepareFor("s")?.release();
		const carried = bank.prepareFor("s");
		expect(carried?.awareness.body).toBe("x:a->b");
		// One carrier at a time, so two messages never carry the same notice.
		expect(bank.prepareFor("s")).toBeNull();

		observe([
			{ sessionKey: "s", identity: "x", pre: "b", post: "c" },
			{ sessionKey: "s", identity: "y", pre: "a", post: "b" },
		]);
		carried?.commit();

		expect(take(bank, "s")?.body).toBe("x:b->c,y:a->b");
		expect(take(bank, "s")).toBeNull();
	});

	it("bounds the notice however much the subscribers render", () => {
		const bank = createAwarenessBank({ liveness: () => "live", deliver: () => true, ambient: processAmbient() });
		const observe = bank.register<string>({
			source: "fake",
			act: () => "no_act",
			render: () => "a long line of change\n".repeat(2_000),
		});
		const unbroken = bank.register<string>({
			source: "unbroken",
			act: () => "no_act",
			render: () => `${"x".repeat(MAX_AWARENESS_BODY_CHARS - 35)}${"\u{1F600}".repeat(50)}`,
		});
		observe([{ sessionKey: "s", identity: "x", pre: "a", post: "b" }]);
		unbroken([{ sessionKey: "t", identity: "x", pre: "a", post: "b" }]);

		expect(take(bank, "s")?.body.length).toBeLessThanOrEqual(MAX_AWARENESS_BODY_CHARS);
		// A lone surrogate would not survive a UTF-8 encode.
		const body = take(bank, "t")?.body ?? "";
		expect(Buffer.from(body, "utf8").toString("utf8")).toBe(body);
	});

	it("drops a gone session's bank that only rides a later message, after the hold", () => {
		let now = 0;
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => "gone",
			deliver: () => true,
		});
		const observe = bank.register<string>({ source: "fake", act: () => "no_act", render: () => "body" });
		observe([{ sessionKey: "s", identity: "x", pre: "a", post: "b" }]);

		now = MAX_HOLD_MS - 1;
		bank.tick();
		bank.prepareFor("s")?.release();
		expect(bank.prepareFor("s")).not.toBeNull();
		bank.prepareFor("s")?.release();
		now = MAX_HOLD_MS;
		bank.tick();
		expect(take(bank, "s")).toBeNull();
	});

	it("keeps the first pre and last post, and drains once", () => {
		const seen: { pre?: string; post?: string }[] = [];
		const bank = createAwarenessBank({ liveness: () => "live", deliver: () => true, ambient: processAmbient() });
		const observe = bank.register<string>({
			source: "fake",
			act: () => "no_act",
			render: (_session, changes) => {
				seen.push(changes[0]);
				return "body";
			},
		});
		observe([
			{ sessionKey: "s", identity: "x", pre: "a", post: "b" },
			{ sessionKey: "s", identity: "x", pre: "b", post: "c" },
		]);
		expect(take(bank, "s")).toEqual({ from: "fake", body: "body", act: "no_act" });
		expect(seen).toEqual([{ identity: "x", pre: "a", post: "c" }]);
		expect(take(bank, "s")).toBeNull();
	});

	it("holds no_act and pushes act_now at its deadline", () => {
		const sent: ChannelPushPayload[] = [];
		let now = 1000;
		const bank = createAwarenessBank({
			liveness: () => "live",
			ambient: fakeAmbient({ now: () => now }),
			deliver: (_s, payload) => {
				sent.push(payload);
				return true;
			},
		});
		const observe = bank.register<string>({
			source: "fake",
			act: (_s, pre) => (pre === "gone" ? "act_now" : "no_act"),
			render: () => "body",
		});
		observe([{ sessionKey: "s", identity: "x", pre: "gone", post: "here" }]);
		now = 60_999;
		bank.tick();
		expect(sent).toHaveLength(0);
		now = 61_000;
		bank.tick();
		expect(sent[0].no_ack).toBe(true);
		expect(sent[0].act).toBe("act_now");
		expect(sent[0].from).toBe("fake");
		expect(isNoAckSessionId(sent[0].session_id)).toBe(true);
	});

	it("does not extend a later act_now observation", () => {
		let now = 0;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => "live",
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
		});
		const observe = bank.register<string>({ source: "fake", act: () => "act_now", render: () => "body" });
		// The first urgent observation owns the deadline.
		observe([{ sessionKey: "s", identity: "a", pre: "x", post: "y" }]);
		now = 30_000;
		observe([{ sessionKey: "s", identity: "b", pre: "x", post: "y" }]);
		now = 59_999;
		bank.tick();
		expect(sent).toHaveLength(0);
		now = 60_000;
		bank.tick();
		expect(sent).toHaveLength(1);
	});

	it("takes urgent content inside the window and cancels its deadline", () => {
		let now = 0;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => "live",
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
		});
		const observe = bank.register<string>({ source: "fake", act: () => "act_now", render: () => "body" });
		// Piggybacking must consume the same content as a standalone fallback.
		observe([{ sessionKey: "s", identity: "a", pre: "x", post: "y" }]);
		now = 10_000;
		expect(take(bank, "s")).toEqual({ from: "fake", body: "body", act: "act_now" });
		now = 120_000;
		bank.tick();
		expect(sent).toHaveLength(0);
	});

	it("uses the net pair for the flushed act axis when it renders empty", () => {
		let now = 0;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => "live",
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
		});
		const observe = bank.register<string>({
			source: "fake",
			act: (_s, _pre, post) => (post === "gone" ? "act_now" : "no_act"),
			render: (_s, changes) => (changes[0].pre === changes[0].post ? "" : "body"),
		});
		// A reversal within one window is no change and must clear silently.
		observe([{ sessionKey: "s", identity: "a", pre: "here", post: "gone" }]);
		now = 5_000;
		observe([{ sessionKey: "s", identity: "a", pre: "gone", post: "here" }]);
		now = 60_000;
		bank.tick();
		expect(sent).toHaveLength(0);
		expect(take(bank, "s")).toBeNull();
	});

	it("uses no_act when the net pair is not gone", () => {
		let now = 0;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => "live",
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
		});
		const observe = bank.register<string>({
			source: "fake",
			act: (_s, _pre, post) => (post === "gone" ? "act_now" : "no_act"),
			render: (_s, changes) => (changes[0].pre === changes[0].post ? "" : "moved"),
		});
		// The final state, not the arming event, decides urgency.
		observe([{ sessionKey: "s", identity: "a", pre: "here", post: "gone" }]);
		now = 5_000;
		observe([{ sessionKey: "s", identity: "a", pre: "gone", post: "elsewhere" }]);
		now = 60_000;
		bank.tick();
		expect(sent[0].act).toBe("no_act");
	});

	it("drops a waking bank after MAX_HOLD_MS", () => {
		let now = 0;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => "waking",
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
		});
		const observe = bank.register<string>({ source: "fake", act: () => "act_now", render: () => "body" });
		// A wake that never lands must not retain memory forever.
		observe([{ sessionKey: "s", identity: "a", pre: "x", post: "y" }]);
		for (now of [60_000, 300_000, 600_001]) bank.tick();
		expect(sent).toHaveLength(0);
		expect(take(bank, "s")).toBeNull();
	});

	it("rechecks waking sessions every second", () => {
		let now = 0;
		let live = false;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => (live ? "live" : "waking"),
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
		});
		const observe = bank.register<string>({ source: "fake", act: () => "act_now", render: () => "body" });
		// Waking is retried until the session becomes deliverable.
		observe([{ sessionKey: "s", identity: "a", pre: "x", post: "y" }]);
		now = 60_000;
		bank.tick();
		now = 61_000;
		bank.tick();
		live = true;
		now = 62_000;
		bank.tick();
		now = 63_000;
		bank.tick();
		expect(sent).toHaveLength(1);
	});

	it("keeps a push that failed, retries it each second, and drops it once the hold runs out", () => {
		let now = 0;
		let attempts = 0;
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => "live",
			deliver: () => {
				attempts++;
				return false;
			},
		});
		const observe = bank.register<string>({ source: "fake", act: () => "act_now", render: () => "body" });
		observe([{ sessionKey: "s", identity: "a", pre: "x", post: "y" }]);
		now = 60_000;
		bank.tick();
		bank.tick();
		now = 61_000;
		bank.tick();
		expect(attempts).toBe(2);

		now = MAX_HOLD_MS;
		bank.tick();
		expect(take(bank, "s")).toBeNull();
	});

	it("forgets what was banked for a session whose work ended, and nothing else", () => {
		let now = 0;
		const deliveredTo: string[] = [];
		const bank = createAwarenessBank({
			ambient: fakeAmbient({ now: () => now }),
			liveness: () => "live",
			deliver: (sessionKey) => {
				deliveredTo.push(sessionKey);
				return true;
			},
		});
		const observe = bank.register<string>({ source: "fake", act: () => "act_now", render: () => "body" });
		observe([
			{ sessionKey: "ended", identity: "x", pre: "x", post: "y" },
			{ sessionKey: "alive", identity: "x", pre: "x", post: "y" },
		]);
		bank.dropFor("ended");
		now = 60_000;
		bank.tick();
		// The sibling session is the control: its push proves the tick ran and only the drop was forgotten.
		expect(deliveredTo).toEqual(["alive"]);
		expect(take(bank, "ended")).toBeNull();
	});

	it("never pushes a no_act-only bank", () => {
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			liveness: () => "live",
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
			ambient: processAmbient(),
		});
		const observe = bank.register<string>({ source: "fake", act: () => "no_act", render: () => "body" });
		// No deadline is needed for awareness that can ride a later message.
		observe([{ sessionKey: "s", identity: "x", pre: "a", post: "b" }]);
		bank.tick(10_000_000);
		expect(sent).toHaveLength(0);
	});

	it("combines sources and omits empty subscribers", () => {
		const bank = createAwarenessBank({ liveness: () => "live", deliver: () => true, ambient: processAmbient() });
		const first = bank.register<string>({ source: "one", act: () => "no_act", render: () => "one" });
		const second = bank.register<string>({ source: "two", act: () => "no_act", render: () => "two" });
		const empty = bank.register<string>({ source: "empty", act: () => "no_act", render: () => "" });
		first([{ sessionKey: "s", identity: "a", pre: "a", post: "b" }]);
		second([{ sessionKey: "s", identity: "b", pre: "a", post: "b" }]);
		empty([{ sessionKey: "s", identity: "c", pre: "a", post: "b" }]);
		expect(take(bank, "s")).toEqual({ from: "awareness", body: "one\n\ntwo", act: "no_act" });
		expect(take(bank, "s")).toBeNull();
	});

	it("holds waking content and delivers when live", () => {
		let live = false;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			liveness: () => (live ? "live" : "waking"),
			ambient: fakeAmbient({ now: () => 0 }),
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
		});
		const observe = bank.register<string>({ source: "fake", act: () => "act_now", render: () => "body" });
		observe([{ sessionKey: "s", identity: "x", pre: "gone", post: "here" }]);
		bank.tick(61_000);
		live = true;
		bank.tick(62_000);
		expect(sent).toHaveLength(1);
	});

	it("drops a banked notice for a session that is gone, and does not deliver it if the session returns", () => {
		let live = false;
		const sent: ChannelPushPayload[] = [];
		const bank = createAwarenessBank({
			liveness: () => (live ? "live" : "gone"),
			ambient: fakeAmbient({ now: () => 0 }),
			deliver: (_s, p) => {
				sent.push(p);
				return true;
			},
		});
		const observe = bank.register<string>({ source: "fake", act: () => "act_now", render: () => "body" });
		observe([{ sessionKey: "s", identity: "x", pre: "gone", post: "here" }]);
		bank.tick(61_000);
		expect(sent).toHaveLength(0);
		// A later incarnation is a different session and must not inherit a notice meant for the old one.
		live = true;
		bank.tick(62_000);
		expect(sent).toHaveLength(0);
		expect(take(bank, "s")).toBeNull();
	});
});
