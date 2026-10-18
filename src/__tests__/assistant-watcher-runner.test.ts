import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createInboxStore, type InboxStore, type Sorter } from "../gateway/assistant/inboxStore.js";
import type { PollAnswer, Watcher } from "../gateway/assistant/watcher.js";
import {
	createWatcherRunner,
	POLL_TIMEOUT_MS,
	RETRY_MS,
	type WatcherRunner,
} from "../gateway/assistant/watcherRunner.js";
import { DurableStore } from "../shared/durable-store.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

/** A fixed base, so manual time moves only when a test advances it. */
const T0 = 1_800_000_000_000;
const NO_RULES: Sorter = {
	sort: () => ({ action: "inbox", ping: false, rulesRevision: 0 }),
	revision: 0,
};

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function inboxOnDisk(): InboxStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-runner-"));
	dirs.push(dir);
	return createInboxStore(new DurableStore(dir, "assistant-inbox"));
}

/** Polls answered by hand; records cursors. */
function scripted(id = "github") {
	const cursors: (string | null)[] = [];
	const pending: ((answer: PollAnswer) => void)[] = [];
	const watcher: Watcher = {
		id,
		poll: (cursor) => {
			cursors.push(cursor);
			return new Promise((resolve) => pending.push(resolve));
		},
	};
	const answer = (value: PollAnswer) => pending.shift()?.(value);
	return { watcher, cursors, answer, inFlight: () => pending.length };
}

const events = (cursor: string, nextPollMs = 60_000): PollAnswer => ({
	kind: "events",
	events: [{ sourceId: cursor, at: 1, title: cursor, fields: {} }],
	cursor,
	nextPollMs,
});

/** Stop's wait needs manual time. */
async function stopped(runner: WatcherRunner, ambient: FakeAmbient): Promise<void> {
	const done = runner.stop();
	await ambient.advance(POLL_TIMEOUT_MS);
	await done;
}

describe("the watcher runner", () => {
	it("polls on the interval each answer names, with the cursor the last one left, never two at once", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const inbox = inboxOnDisk();
		const source = scripted();
		const runner = createWatcherRunner({ ambient, inbox, watchers: [source.watcher], rules: () => NO_RULES });

		runner.start();
		await ambient.advance(30_000);
		const whileHung = source.inFlight();
		source.answer(events("c1", 30_000));
		await ambient.advance(0);
		await ambient.advance(29_999);
		const beforeInterval = source.cursors.length;
		await ambient.advance(1);
		await stopped(runner, ambient);

		expect(whileHung).toBe(1);
		expect(beforeInterval).toBe(1);
		expect(source.cursors).toEqual([null, "c1"]);
		expect(inbox.unread("github", ambient.now())).toBe(1);
	});

	it("backs off after a throw or a hang, keeping the cursor", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const inbox = inboxOnDisk();
		const cursors: (string | null)[] = [];
		const watcher: Watcher = {
			id: "github",
			poll: (cursor) => {
				cursors.push(cursor);
				if (cursors.length === 1) return Promise.resolve(events("c1"));
				if (cursors.length === 2) return Promise.reject(new Error("socket hang up"));
				return new Promise(() => undefined);
			},
		};
		const runner = createWatcherRunner({ ambient, inbox, watchers: [watcher], rules: () => NO_RULES });

		runner.start();
		await ambient.advance(60_000);
		const thrown = inbox.stateOf("github", ambient.now())?.backoff?.reason;
		await ambient.advance(RETRY_MS - 1);
		const beforeRetry = cursors.length;
		await ambient.advance(1 + POLL_TIMEOUT_MS);
		const hung = inbox.stateOf("github", ambient.now())?.backoff;
		await stopped(runner, ambient);

		expect(thrown).toBe("socket hang up");
		expect(beforeRetry).toBe(2);
		expect(hung).toBeDefined();
		expect(cursors).toEqual([null, "c1", "c1"]);
	});

	it("runs each watcher on its own clock, and aborts a poll it gave up on", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const inbox = inboxOnDisk();
		const fast = scripted("fast");
		const signals: AbortSignal[] = [];
		const hanging: Watcher = {
			id: "slow",
			poll: (_cursor, signal) => {
				signals.push(signal);
				return new Promise(() => undefined);
			},
		};
		const runner = createWatcherRunner({
			ambient,
			inbox,
			watchers: [fast.watcher, hanging],
			rules: () => NO_RULES,
		});

		runner.start();
		await ambient.advance(0);
		fast.answer(events("f1", 10_000));
		await ambient.advance(0);
		await ambient.advance(10_000);
		fast.answer(events("f2", 10_000));
		await ambient.advance(POLL_TIMEOUT_MS);
		await stopped(runner, ambient);

		expect(fast.cursors.slice(0, 3)).toEqual([null, "f1", "f2"]);
		expect(signals[0]?.aborted).toBe(true);
	});

	it("leaves a stopped watcher alone until the runner starts again", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const inbox = inboxOnDisk();
		const source = scripted();
		const first = createWatcherRunner({ ambient, inbox, watchers: [source.watcher], rules: () => NO_RULES });

		first.start();
		await ambient.advance(0);
		source.answer({ kind: "stopped", reason: "needs a secret" });
		await ambient.advance(0);
		await ambient.advance(24 * 60 * 60 * 1000);
		const whileStopped = source.cursors.length;
		await stopped(first, ambient);
		const second = createWatcherRunner({ ambient, inbox, watchers: [source.watcher], rules: () => NO_RULES });
		second.start();
		await ambient.advance(0);
		await stopped(second, ambient);

		expect(whileStopped).toBe(1);
		expect(source.cursors).toHaveLength(2);
	});

	it("writes nothing a poll answers after the runner stopped", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const inbox = inboxOnDisk();
		const source = scripted();
		const runner = createWatcherRunner({ ambient, inbox, watchers: [source.watcher], rules: () => NO_RULES });

		runner.start();
		await ambient.advance(0);
		await stopped(runner, ambient);
		source.answer(events("late"));
		await ambient.advance(0);

		expect(inbox.events("github", ambient.now())).toEqual([]);
		expect(inbox.stateOf("github", ambient.now())).toBeUndefined();
	});

	it("runs the landed hook after every landed poll, empty ones too, and keeps polling when it throws", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const inbox = inboxOnDisk();
		const source = scripted();
		let landed = 0;
		const runner = createWatcherRunner({
			ambient,
			inbox,
			watchers: [source.watcher],
			rules: () => NO_RULES,
			onLanded: () => {
				landed += 1;
				throw new Error("delivery failed");
			},
		});

		runner.start();
		await ambient.advance(0);
		source.answer(events("c1", 10_000));
		await ambient.advance(0);
		await ambient.advance(10_000);
		source.answer({ kind: "events", events: [], cursor: "c2", nextPollMs: 10_000 });
		await ambient.advance(0);
		await ambient.advance(10_000);
		await stopped(runner, ambient);

		expect(source.cursors).toEqual([null, "c1", "c2"]);
		expect(landed).toBe(2);
	});

	it("stops for good, leaving no timer behind a poll that ignores its abort", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		let polls = 0;
		const deaf: Watcher = {
			id: "deaf",
			poll: () => {
				polls += 1;
				return new Promise(() => undefined);
			},
		};
		const runner = createWatcherRunner({ ambient, inbox: inboxOnDisk(), watchers: [deaf], rules: () => NO_RULES });

		runner.start();
		await ambient.advance(0);
		const done = runner.stop();
		await ambient.advance(5_000);
		await done;
		const left = ambient.scheduled();
		runner.start();
		await ambient.advance(10 * 60_000);

		expect(left).toBe(0);
		expect(polls).toBe(1);
	});

	it("refuses two watchers with one id", () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const twice = [scripted().watcher, scripted().watcher];

		expect(() =>
			createWatcherRunner({ ambient, inbox: inboxOnDisk(), watchers: twice, rules: () => NO_RULES }),
		).toThrow();
	});

	it("resumes at the stored next poll after a restart, and arms nothing once stopped", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const inbox = inboxOnDisk();
		inbox.commitPoll("github", events("c1", 600_000), ambient.now(), NO_RULES);
		const source = scripted();
		const runner = createWatcherRunner({ ambient, inbox, watchers: [source.watcher], rules: () => NO_RULES });

		runner.start();
		await ambient.advance(599_999);
		const early = source.cursors.length;
		await ambient.advance(1);
		source.answer(events("c2"));
		await stopped(runner, ambient);
		await ambient.advance(10 * 60_000);

		expect(early).toBe(0);
		expect(source.cursors).toEqual(["c1"]);
	});

	it("asks again with the old cursor when the write does not land", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const real = inboxOnDisk();
		let refuse = true;
		const inbox: Pick<InboxStore, "commitPoll" | "stateOf"> = {
			commitPoll: (...args) => {
				if (!refuse) return real.commitPoll(...args);
				refuse = false;
				return null;
			},
			stateOf: (id) => real.stateOf(id, ambient.now()),
		};
		const source = scripted();
		const runner = createWatcherRunner({ ambient, inbox, watchers: [source.watcher], rules: () => NO_RULES });

		runner.start();
		await ambient.advance(0);
		source.answer(events("c1"));
		await ambient.advance(0);
		await ambient.advance(RETRY_MS);
		source.answer(events("c1"));
		await ambient.advance(0);
		await stopped(runner, ambient);

		expect(source.cursors).toEqual([null, null]);
		expect(real.stateOf("github", ambient.now())?.cursor).toBe("c1");
	});
});
