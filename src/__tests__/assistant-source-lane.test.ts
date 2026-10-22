import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	type AssistantWake,
	createSourceLanes,
	laneEnd,
	POLL_TIMEOUT_MS,
	RETRY_MS,
	type SourceLanes,
	WAKE_DEADLINE_MS,
	WAKE_RETRY_MS,
} from "../gateway/assistant/sourceLane.js";
import type { PollAnswer, Watcher, WatcherEvent } from "../gateway/assistant/watcher.js";
import { createWatcherStateStore, type WatcherStateStore } from "../gateway/assistant/watcherState.js";
import { ChannelDeliveryCoordinator } from "../gateway/channelDelivery.js";
import { DurableStore } from "../shared/durable-store.js";
import { type EventMember, PendingDeliveryStore } from "../shared/pending-delivery-store.js";
import type { RuleAction } from "../shared/schemasAssistantRules.js";
import { type FakeAmbient, fakeAmbient } from "../testing/fakeAmbient.js";

/** Fixed clock base. */
const T0 = 1_800_000_000_000;

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-lane-"));
	dirs.push(dir);
	return dir;
}

const stateIn = (dir: string): WatcherStateStore =>
	createWatcherStateStore(new DurableStore(dir, "assistant-watchers"));

const thread = (id: string, at: number, reason = "mention"): WatcherEvent => ({
	id,
	at,
	title: `Thread ${id}`,
	fields: { reason },
});

const unread = (cursor: string, events: WatcherEvent[], nextPollMs = 60_000): PollAnswer => ({
	kind: "events",
	events,
	cursor,
	capped: false,
	nextPollMs,
});

/** Polls answered by hand; records the validator each sent. */
function scripted(id = "github") {
	const cursors: (string | null)[] = [];
	const signals: AbortSignal[] = [];
	const pending: ((answer: PollAnswer) => void)[] = [];
	const watcher: Watcher = {
		id,
		label: `${id} label`,
		poll: (cursor, signal) => {
			cursors.push(cursor);
			signals.push(signal);
			return new Promise((resolve) => pending.push(resolve));
		},
		list: async () => ({ events: [thread("listed", 1)], here: "0" }),
	};
	const answer = (value: PollAnswer) => pending.shift()?.(value);
	return { watcher, cursors, signals, answer, inFlight: () => pending.length };
}

/** Composes once reached, as `deliverEvent` does; `late` waits for `release`. */
function wakes(answers: (string | null | "hang" | "late")[] = []) {
	const pushed: { keys: string[]; ids: string[] }[] = [];
	const releases: (() => void)[] = [];
	const lateComposed: unknown[] = [];
	const record = (members: readonly EventMember[] | null) => {
		if (members) pushed.push({ keys: members.map((m) => m.key), ids: members.map((m) => m.text) });
		return members;
	};
	const wake: AssistantWake = async (event) => {
		const next = answers.shift() ?? null;
		if (next === "hang") return new Promise(() => undefined);
		if (next === "late") {
			return new Promise((resolve) => {
				releases.push(() => {
					lateComposed.push(record(event.compose()));
					resolve(null);
				});
			});
		}
		record(event.compose());
		return next;
	};
	const release = () => {
		for (const late of releases.splice(0)) late();
	};
	return { wake, pushed, release, lateComposed };
}

/** Real queue, session asleep; a string refuses. */
function queued(dir: string, answers: (string | null)[] = []) {
	const store = new PendingDeliveryStore(new DurableStore(dir, "pending-deliveries"), { now: () => T0 });
	const coordinator = new ChannelDeliveryCoordinator({ store, registry: new Map() });
	const wake: AssistantWake = async (event) => {
		const refused = answers.shift() ?? null;
		if (refused) return refused;
		const members = event.compose();
		if (!members) return null;
		const outcome = coordinator.acceptEvent({ team: "host.assistant", members, enqueuedAt: T0 });
		return outcome === "refused" || outcome === "migrating" ? outcome : null;
	};
	const rows = () => store.listForTeam("host.assistant").map((row) => row.body.split("\n\n"));
	return { wake, coordinator, rows, held: () => store.listForTeam("host.assistant") };
}

/** The `put` numbered in `failing` does not land. */
function flaky(inner: WatcherStateStore, failing: number[]): WatcherStateStore {
	let puts = 0;
	return {
		get: (watcherId) => inner.get(watcherId),
		put: (watcherId, next) => {
			puts += 1;
			return failing.includes(puts) ? false : inner.put(watcherId, next);
		},
	};
}

function lanes(
	ambient: FakeAmbient,
	state: WatcherStateStore,
	watcher: Watcher,
	wake: AssistantWake,
	sort: (event: WatcherEvent) => RuleAction = () => "wake",
): SourceLanes {
	return createSourceLanes({
		ambient,
		state,
		watchers: [watcher],
		sort: (_watcherId, event) => sort(event),
		wake: () => wake,
		to: "host.assistant",
		render: (_watcher, event) => event.id,
	});
}

/** Stop's wait needs manual time. */
async function stopped(lane: SourceLanes, ambient: FakeAmbient): Promise<void> {
	const done = lane.stop();
	await ambient.advance(POLL_TIMEOUT_MS);
	await done;
}

describe("a watcher's source lane", () => {
	it("refuses a watcher with no label, so none shows by its id", () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const unnamed = { ...scripted().watcher, label: "  " };

		expect(() => lanes(ambient, stateIn(stateDir()), unnamed, wakes().wake)).toThrow("no label");
	});

	it("polls on the interval each answer names, sending the validator the last commit left, never two at once", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const lane = lanes(ambient, stateIn(stateDir()), source.watcher, wakes().wake);

		lane.start();
		await ambient.advance(30_000);
		lane.poke("github");
		lane.poke("github");
		await ambient.advance(0);
		const whileHung = source.inFlight();
		source.answer(unread("c1", [], 30_000));
		await ambient.advance(0);
		const poked = source.cursors.length;
		source.answer({ kind: "unchanged", nextPollMs: 30_000 });
		await ambient.advance(0);
		await ambient.advance(29_999);
		const beforeInterval = source.cursors.length;
		await ambient.advance(1);
		await stopped(lane, ambient);

		expect(whileHung).toBe(1);
		expect(poked).toBe(2);
		expect(beforeInterval).toBe(2);
		expect(source.cursors).toEqual([null, "c1", "c1"]);
	});

	it("sees the backlog at the first poll without waking, then wakes only what is newer than the newest seen", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const state = stateIn(stateDir());
		const pushes = wakes();
		const lane = lanes(ambient, state, source.watcher, pushes.wake, (event) =>
			event.fields.reason === "subscribed" ? "inbox" : "wake",
		);

		lane.start();
		await ambient.advance(0);
		source.answer(unread("c1", [thread("a", 200), thread("b", 100)]));
		await ambient.advance(0);
		await ambient.advance(60_000);
		source.answer(
			unread("c2", [thread("d", 400, "subscribed"), thread("e", 300), thread("tie", 200), thread("a", 200)]),
		);
		await ambient.advance(0);
		await ambient.advance(60_000);
		source.answer(unread("c3", [thread("d", 400, "subscribed"), thread("e", 300)]));
		await ambient.advance(0);
		await ambient.advance(60_000);
		await stopped(lane, ambient);

		expect(pushes.pushed.map((push) => push.ids)).toEqual([["e"]]);
		expect(source.cursors).toEqual([null, "c1", "c2", "c3"]);
		expect(state.get("github").unread).toBe(2);
	});

	it("commits only once every push is queued, polling a failed one again from the checkpoint with doubling backoff", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const state = stateIn(stateDir());
		const pushes = wakes(["the session is not reachable", "the session is not reachable", null]);
		const lane = lanes(ambient, state, source.watcher, pushes.wake);

		lane.start();
		await ambient.advance(0);
		source.answer(unread("c1", [thread("a", 100)]));
		await ambient.advance(0);
		await ambient.advance(60_000);
		source.answer(unread("c2", [thread("b", 200), thread("a", 100)]));
		await ambient.advance(0);
		const failed = state.get("github");
		await ambient.advance(WAKE_RETRY_MS - 1);
		const beforeRetry = source.cursors.length;
		await ambient.advance(1);
		source.answer(unread("c2", [thread("b", 200), thread("a", 100)]));
		await ambient.advance(0);
		await ambient.advance(2 * WAKE_RETRY_MS - 1);
		const beforeDoubled = source.cursors.length;
		await ambient.advance(1);
		source.answer(unread("c3", [thread("b", 200), thread("a", 100)]));
		await ambient.advance(0);
		await ambient.advance(60_000);
		source.answer(unread("c4", [thread("b", 200), thread("a", 100)]));
		await ambient.advance(0);
		await stopped(lane, ambient);

		expect(failed.unread).toBe(2);
		expect(failed.backoff).toBeDefined();
		expect([beforeRetry, beforeDoubled]).toEqual([2, 3]);
		expect(source.cursors).toEqual([null, "c1", "c1", "c1", "c3"]);
		expect(new Set(pushes.pushed.map((push) => JSON.stringify(push.keys))).size).toBe(1);
		expect(pushes.pushed).toHaveLength(3);
		expect(state.get("github").backoff).toBeUndefined();
	});

	it("gives a push its deadline, frees the lane for work queued behind, and lets a late landing send nothing", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const state = stateIn(stateDir());
		const pushes = wakes(["late"]);
		const lane = lanes(ambient, state, source.watcher, pushes.wake);

		lane.start();
		await ambient.advance(0);
		source.answer(unread("c1", []));
		await ambient.advance(0);
		await ambient.advance(60_000);
		source.answer(unread("c2", [thread("a", 100)]));
		const listed = lane.read(
			"github",
			2 * WAKE_DEADLINE_MS,
			async (watcher, signal) => (await watcher.list?.({ scope: "all" }, signal))?.events ?? [],
			(events) => events.map((event) => event.id),
		);
		await ambient.advance(0);
		await ambient.advance(WAKE_DEADLINE_MS);
		const listing = await listed;
		const ids = listing.kind === "ran" ? listing.value : [];
		pushes.release();
		await ambient.advance(WAKE_RETRY_MS);
		source.answer(unread("c2", [thread("a", 100)]));
		await ambient.advance(0);
		await stopped(lane, ambient);

		expect(ids).toEqual(["listed"]);
		expect(pushes.lateComposed).toEqual([null]);
		expect(source.cursors).toEqual([null, "c1", "c1"]);
		expect(pushes.pushed.map((push) => push.ids)).toEqual([["a"]]);
	});

	it("holds the lane through a write until it settles, its signal ending at the deadline, while work behind waits", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const lane = lanes(ambient, stateIn(stateDir()), source.watcher, wakes().wake);

		lane.start();
		await ambient.advance(0);
		source.answer(unread("c1", []));
		await ambient.advance(0);
		let release = () => {};
		let held: AbortSignal | undefined;
		const wrote = lane.write("github", 2_000, (signal) => {
			held = signal;
			return new Promise<string>((resolve) => {
				release = () => resolve("written");
			});
		});
		const read = lane.read(
			"github",
			1_000,
			async () => "read",
			(value) => value,
		);
		lane.poke("github");
		await ambient.advance(2_000);
		const readAnswer = await read;
		const endWhileHeld = held && laneEnd(held);
		const pollsWhileHeld = source.cursors.length;
		release();
		const written = await wrote;
		await ambient.advance(0);
		const pollsAfter = source.cursors.length;
		await stopped(lane, ambient);

		expect(readAnswer).toEqual({ kind: "not_started", end: "past_deadline" });
		expect(endWhileHeld).toBe("past_deadline");
		expect(pollsWhileHeld).toBe(1);
		expect(written).toEqual({ kind: "ran", value: "written" });
		expect(pollsAfter).toBe(2);
	});

	it("answers a write it never started by its deadline, and runs nothing when the lane frees", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const lane = lanes(ambient, stateIn(stateDir()), source.watcher, wakes().wake);
		let ran = false;

		lane.start();
		await ambient.advance(0);
		const wrote = lane.write("github", 1_000, async () => {
			ran = true;
			return "sent";
		});
		await ambient.advance(1_000);
		const answer = await wrote;
		source.answer(unread("c1", []));
		await ambient.advance(0);
		await stopped(lane, ambient);

		expect(answer).toEqual({ kind: "not_started", end: "past_deadline" });
		expect(ran).toBe(false);
	});

	it("frees the lane from a read at its deadline, and a load landing after it settles nothing", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const lane = lanes(ambient, stateIn(stateDir()), source.watcher, wakes().wake);
		let land = (_value: string) => {};
		let settled = false;

		const read = lane.read(
			"github",
			1_000,
			() =>
				new Promise<string>((resolve) => {
					land = resolve;
				}),
			(value) => {
				settled = true;
				return value;
			},
		);
		const behind = lane.write("github", 5_000, async () => "next");
		await ambient.advance(0);
		await ambient.advance(1_000);
		const answer = await read;
		const next = await behind;
		land("late");
		await ambient.advance(0);

		expect(answer).toEqual({ kind: "gave_up", end: "past_deadline" });
		expect(next).toEqual({ kind: "ran", value: "next" });
		expect(settled).toBe(false);
	});

	it("ends running and queued work at once on stop, each signal saying why", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const lane = lanes(ambient, stateIn(stateDir()), source.watcher, wakes().wake);
		let held: AbortSignal | undefined;

		const running = lane.write("github", 60_000, (signal) => {
			held = signal;
			return new Promise<string>((resolve) => {
				signal.addEventListener("abort", () => resolve("cut"), { once: true });
			});
		});
		const behind = lane.write("github", 60_000, async () => "never");
		await ambient.advance(0);
		await lane.stop();

		expect(held && laneEnd(held)).toBe("stopping");
		expect(await running).toEqual({ kind: "ran", value: "cut" });
		expect(await behind).toEqual({ kind: "not_started", end: "stopping" });
	});

	it("polls again from the committed checkpoint after a restart, keeping the backoff it had reached", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const dir = stateDir();
		const first = scripted();
		const failing = lanes(ambient, stateIn(dir), first.watcher, wakes(["the session is not reachable"]).wake);
		failing.start();
		await ambient.advance(0);
		first.answer(unread("c1", []));
		await ambient.advance(0);
		await ambient.advance(60_000);
		first.answer(unread("c2", [thread("a", 100)]));
		await ambient.advance(0);
		await stopped(failing, ambient);

		const second = scripted();
		const pushes = wakes(["the session is not reachable", null]);
		const restarted = lanes(ambient, stateIn(dir), second.watcher, pushes.wake);
		restarted.start();
		await ambient.advance(0);
		second.answer(unread("c2", [thread("a", 100)]));
		await ambient.advance(0);
		await ambient.advance(2 * WAKE_RETRY_MS - 1);
		const beforeDoubled = second.cursors.length;
		await ambient.advance(1);
		second.answer(unread("c2", [thread("a", 100)]));
		await ambient.advance(0);
		await stopped(restarted, ambient);

		expect(beforeDoubled).toBe(1);
		expect(second.cursors).toEqual(["c1", "c1"]);
		expect(pushes.pushed.map((push) => push.ids)).toEqual([["a"], ["a"]]);
	});

	it("pushes wake candidates oldest first, twenty at a time, and the queue takes a retried push once", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const queue = queued(stateDir(), [null, "the session is not reachable"]);
		const lane = lanes(ambient, stateIn(stateDir()), source.watcher, queue.wake);
		const backlog = Array.from({ length: 25 }, (_, i) => thread(`t${25 - i}`, 25 - i));
		const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `t${from + i}`);

		lane.start();
		await ambient.advance(0);
		source.answer(unread("c1", []));
		await ambient.advance(0);
		await ambient.advance(60_000);
		source.answer(unread("c2", backlog));
		await ambient.advance(0);
		await ambient.advance(WAKE_RETRY_MS);
		source.answer(unread("c2", backlog));
		await ambient.advance(0);
		await stopped(lane, ambient);

		expect(queue.rows()).toEqual([ids(1, 20), ids(21, 25)]);
		expect(source.cursors).toEqual([null, "c1", "c1"]);
	});

	it("delivers a landed push once when its commit did not land, even across a restart after the session read it", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const dir = stateDir();
		const queueDir = stateDir();
		const first = scripted();
		const queue = queued(queueDir);
		const state = stateIn(dir);
		const failing = lanes(ambient, flaky(state, [2]), first.watcher, queue.wake);
		failing.start();
		await ambient.advance(0);
		first.answer(unread("c1", []));
		await ambient.advance(0);
		await ambient.advance(60_000);
		first.answer(unread("c2", [thread("a", 100)]));
		await ambient.advance(0);
		await stopped(failing, ambient);
		const landed = queue.held().map((row) => row.deliveryId);
		for (const deliveryId of landed) queue.coordinator.acknowledge(deliveryId);

		const second = scripted();
		const reopened = queued(queueDir);
		const restarted = lanes(ambient, stateIn(dir), second.watcher, reopened.wake);
		restarted.start();
		await ambient.advance(0);
		second.answer(unread("c2", [thread("a", 100)]));
		await ambient.advance(0);
		await stopped(restarted, ambient);

		expect(landed).toHaveLength(1);
		expect(second.cursors).toEqual(["c1"]);
		expect(reopened.rows()).toEqual([]);
		expect(stateIn(dir).get("github")).toMatchObject({ cursor: "c2", newest: 100 });
	});

	it("backs off after a throw, a hang or a malformed answer, and a stopped watcher waits for a poke", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const state = stateIn(stateDir());
		const cursors: (string | null)[] = [];
		const watcher: Watcher = {
			id: "github",
			label: "GitHub",
			poll: (cursor) => {
				cursors.push(cursor);
				if (cursors.length === 1) return Promise.reject(new Error("socket hang up"));
				if (cursors.length === 2) return new Promise(() => undefined);
				if (cursors.length === 3) return Promise.resolve({ kind: "events" } as unknown as PollAnswer);
				return Promise.resolve({ kind: "stopped", reason: "needs a secret" });
			},
		};
		const lane = lanes(ambient, state, watcher, wakes().wake);

		lane.start();
		await ambient.advance(0);
		const thrown = state.get("github").backoff?.reason;
		await ambient.advance(RETRY_MS + POLL_TIMEOUT_MS);
		const hung = state.get("github").backoff;
		await ambient.advance(RETRY_MS);
		const malformed = state.get("github").backoff?.reason;
		await ambient.advance(RETRY_MS);
		const stoppedReason = state.get("github").stopped;
		await ambient.advance(10 * RETRY_MS);
		const whileStopped = cursors.length;
		lane.poke("github");
		await ambient.advance(0);
		await stopped(lane, ambient);

		expect(thrown).toBe("socket hang up");
		expect(hung).toBeDefined();
		expect(malformed).toBe("poll answered malformed data");
		expect(stoppedReason).toBe("needs a secret");
		expect(whileStopped).toBe(4);
		expect(cursors).toHaveLength(5);
	});

	it("aborts a poll in flight on stop and lands nothing after it", async () => {
		const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
		const source = scripted();
		const state = stateIn(stateDir());
		const lane = lanes(ambient, state, source.watcher, wakes().wake);

		lane.start();
		await ambient.advance(0);
		await stopped(lane, ambient);
		source.answer(unread("late", [thread("a", 100)]));
		await ambient.advance(0);

		expect(source.signals[0]?.aborted).toBe(true);
		expect(state.get("github")).toMatchObject({ cursor: null, primed: false });
		expect(
			await lane.read(
				"github",
				1_000,
				async () => "late",
				(value) => value,
			),
		).toEqual({ kind: "not_started", end: "stopping" });
	});
});
