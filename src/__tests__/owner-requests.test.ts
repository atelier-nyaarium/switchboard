import { describe, expect, it } from "vitest";
import {
	CLAIMED_ANSWER_GRACE_MS,
	type CollectUntilInput,
	createOwnerRequests,
	type OpenStub,
	type OwnerRequestOpened,
} from "../gateway/ownerRequests.js";
import type { TimerHandle } from "../shared/ambient.js";
import { MIGRATING } from "../shared/migration-fence.js";

interface Row {
	requestId: string;
	sessionTarget: string;
	deadlineAt: number;
}

interface Payload {
	conversationId: string;
}

interface ManualTimer {
	run: () => void;
	delay: number;
	active: boolean;
}

function manualAmbient() {
	let now = 1_000;
	let id = 0;
	const timers: ManualTimer[] = [];
	const ambient = {
		now: () => now,
		newId: () => `request-${++id}`,
		setTimer: (run: () => void, delay: number) => {
			const timer = { run, delay, active: true };
			timers.push(timer);
			return timer as unknown as TimerHandle;
		},
		clearTimer: (handle: TimerHandle) => {
			(handle as unknown as ManualTimer).active = false;
		},
	};
	const activeTimer = () => [...timers].reverse().find((timer) => timer.active);
	const fire = (timer = activeTimer()) => {
		if (!timer) throw new Error("no timer is armed");
		timer.active = false;
		timer.run();
	};
	return {
		ambient,
		timers,
		activeTimer,
		fire,
		setNow: (next: number) => {
			now = next;
		},
	};
}

function bench(
	options: {
		collectUntil?: (input: CollectUntilInput) => number;
		deliver?: (request: Row) => boolean | typeof MIGRATING;
		onSettled?: (request: Row) => boolean;
		onUnanswered?: (request: Row) => void;
		ledger?: { load: () => unknown; save: (state: unknown) => void };
		maxOpenPerTarget?: number;
	} = {},
) {
	const time = manualAmbient();
	const requests = createOwnerRequests<Row, string, Payload>({
		ambient: time.ambient,
		deadlineMs: 100,
		maxOpenPerTarget: options.maxOpenPerTarget ?? 8,
		deliver: options.deliver ?? (() => true),
		lapsed: (why) => why,
		onSettled: options.onSettled,
		onUnanswered: options.onUnanswered,
		ledger: options.ledger,
		collectUntil: options.collectUntil ?? (({ cause, at, deadlineAt }) => (cause === "answered" ? deadlineAt : at)),
	});
	const open = (sessionTarget = "host.a", payload: Payload = { conversationId: "conversation-a" }) =>
		requests.open({
			sessionTarget,
			payload,
			build: (requestId, deadlineAt) => ({ requestId, sessionTarget, deadlineAt }),
		});
	return { ...time, requests, open };
}

function requireOpen<R, A>(opened: OwnerRequestOpened<R, A>) {
	if (opened.kind !== "opened") throw new Error("request did not open");
	return opened;
}

describe("owner requests", () => {
	it("releases failed deliveries and preserves ledger cleanup", () => {
		let saved: unknown = null;
		const ledger = { load: () => saved, save: (state: unknown) => (saved = state) };
		const failures: Array<(request: Row) => boolean | typeof MIGRATING> = [() => false, () => MIGRATING];
		for (const deliver of failures) {
			const { open } = bench({ deliver, ledger });
			expect(open().kind).toBe("undeliverable");
			expect(saved).toEqual({ v: 1, open: [] });
		}
		const { open } = bench({
			deliver: () => {
				throw new Error("delivery failed");
			},
			ledger,
		});
		expect(() => open()).toThrow("delivery failed");
		expect(saved).toEqual({ v: 1, open: [] });
	});

	it("claims once, carries payload, and holds the answer through grace", async () => {
		const { requests, open, setNow } = bench({ collectUntil: ({ at }) => at });
		const opened = requireOpen(open());
		expect([...requests.payloads()]).toEqual([{ conversationId: "conversation-a" }]);
		const claimed = requests.claim(opened.request.requestId);
		expect(claimed).toEqual({ request: opened.request, payload: { conversationId: "conversation-a" } });
		expect([...requests.payloads()]).toEqual([claimed?.payload]);
		expect(requests.answered(opened.request.requestId)).toBe(true);
		expect(requests.settle(opened.request.requestId, "sent")).toBe(true);
		await expect(opened.answer).resolves.toBe("sent");
		expect([...requests.payloads()]).toEqual([]);
		setNow(1_000 + CLAIMED_ANSWER_GRACE_MS - 1);
		expect(requests.collect(opened.request.requestId, "host.a")).toBeDefined();
		setNow(1_000 + CLAIMED_ANSWER_GRACE_MS);
		expect(requests.collect(opened.request.requestId, "host.a")).toBeUndefined();
	});

	it("keeps a denial collectable as an answered result", async () => {
		const { requests, open } = bench();
		const opened = requireOpen(open());
		expect(requests.settle(opened.request.requestId, "denied")).toBe(true);
		await expect(opened.answer).resolves.toBe("denied");
		expect(requests.answered(opened.request.requestId)).toBe(true);
		expect(requests.collect(opened.request.requestId, "host.a")).toBeDefined();
		expect(requests.settle(opened.request.requestId, "sent")).toBe(false);
	});

	it("expires by timer or read at the same instant and notifies unanswered once", async () => {
		const expiredByTimer: Row[] = [];
		const timerCase = bench({
			collectUntil: ({ at }) => at + 50,
			onUnanswered: (request) => expiredByTimer.push(request),
		});
		const timerOpen = requireOpen(timerCase.open());
		timerCase.setNow(timerOpen.request.deadlineAt);
		timerCase.fire();
		await expect(timerOpen.answer).resolves.toBe("expired");
		expect(timerCase.requests.collect(timerOpen.request.requestId, "host.a")).toBeDefined();
		expect(expiredByTimer).toEqual([timerOpen.request]);

		const expiredByRead: Row[] = [];
		const readCase = bench({
			collectUntil: ({ at }) => at + 50,
			onUnanswered: (request) => expiredByRead.push(request),
		});
		const readOpen = requireOpen(readCase.open());
		readCase.setNow(readOpen.request.deadlineAt);
		expect(readCase.requests.live(readOpen.request.requestId)).toBeNull();
		await expect(readCase.requests.collect(readOpen.request.requestId, "host.a")?.answer).resolves.toBe("expired");
		expect(readCase.requests.answered(readOpen.request.requestId)).toBe(false);
		expect(expiredByRead).toEqual([readOpen.request]);
		readCase.setNow(readOpen.request.deadlineAt + 49);
		expect(readCase.requests.collect(readOpen.request.requestId, "host.a")).toBeDefined();
		readCase.setNow(readOpen.request.deadlineAt + 50);
		expect(readCase.requests.collect(readOpen.request.requestId, "host.a")).toBeUndefined();
	});

	it("re-arms an early settled timer and retires at its deadline", async () => {
		const { requests, open, setNow, fire, activeTimer } = bench({ collectUntil: ({ at }) => at + 50 });
		const opened = requireOpen(open());
		requests.settle(opened.request.requestId, "done");
		await expect(opened.answer).resolves.toBe("done");
		setNow(1_049);
		fire();
		expect(activeTimer()?.delay).toBe(1);
		expect(requests.collect(opened.request.requestId, "host.a")).toBeDefined();
		setNow(1_050);
		fire();
		expect(requests.collect(opened.request.requestId, "host.a")).toBeUndefined();
	});

	it("withdraws, ends, closes, and consumes only settled entries", async () => {
		const { requests, open } = bench();
		const withdrawn = requireOpen(open());
		expect(requests.withdraw(withdrawn.request.requestId, "host.other")).toBe(false);
		expect(requests.withdraw(withdrawn.request.requestId, "host.a")).toBe(true);
		await expect(withdrawn.answer).resolves.toBe("withdrawn");
		expect(requests.collect(withdrawn.request.requestId, "host.a")).toBeUndefined();

		const ended = requireOpen(open("host.b"));
		requests.sessionEnded("host.b");
		await expect(ended.answer).resolves.toBe("ended");
		expect(requests.collect(ended.request.requestId, "host.b")).toBeUndefined();

		const closed = requireOpen(open("host.c"));
		requests.closeWhere((request) => request.sessionTarget === "host.c", "closed");
		await expect(closed.answer).resolves.toBe("closed");
		expect(requests.take(closed.request.requestId)).toBe(false);
	});

	it("ticks joins and the target cap before reading open requests", async () => {
		const { requests, open, setNow } = bench({ maxOpenPerTarget: 1 });
		const first = requireOpen(open());
		const joined = requests.find((request) => request.requestId === first.request.requestId);
		expect(joined?.payload).toEqual({ conversationId: "conversation-a" });
		if (joined) joined.payload.conversationId = "conversation-b";
		setNow(first.request.deadlineAt);
		expect(requests.find(() => true)).toBeUndefined();
		const next = requireOpen(open());
		await expect(first.answer).resolves.toBe("expired");
		expect(next.request.requestId).not.toBe(first.request.requestId);
	});

	it("retries restart retractions until each stub queues", async () => {
		let saved: unknown = null;
		const ledger = { load: () => saved, save: (state: unknown) => (saved = state) };
		let failedId = "";
		let refusedId = "";
		const before = bench({
			ledger,
			onSettled: (request) => {
				if (request.requestId === failedId) throw new Error("retraction failed");
				if (request.requestId === refusedId) return false;
				return true;
			},
		});
		const kept = requireOpen(before.open("host.kept"));
		const answered = requireOpen(before.open("host.answered"));
		const unretracted = requireOpen(before.open("host.unretracted"));
		const refused = requireOpen(before.open("host.refused"));
		failedId = unretracted.request.requestId;
		refusedId = refused.request.requestId;
		before.requests.settle(answered.request.requestId, "done");
		before.requests.settle(unretracted.request.requestId, "done");
		before.requests.settle(refused.request.requestId, "done");
		await Promise.all([answered.answer, unretracted.answer, refused.answer]);

		const after = bench({ ledger });
		const tried: OpenStub[] = [];
		after.requests.retractStale((stub) => {
			tried.push(stub);
			return false;
		});
		after.requests.retractStale((stub) => {
			tried.push(stub);
			return true;
		});
		after.requests.retractStale(() => true);
		expect(tried.map((stub) => stub.requestId).sort()).toEqual(
			[
				kept.request.requestId,
				unretracted.request.requestId,
				refused.request.requestId,
				kept.request.requestId,
				unretracted.request.requestId,
				refused.request.requestId,
			].sort(),
		);
	});
});
