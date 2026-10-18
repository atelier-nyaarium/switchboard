import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createInboxStore, type InboxStore } from "../gateway/assistant/inboxStore.js";
import {
	type AssistantWake,
	createWakeRunner,
	WAKE_BATCH,
	WAKE_RETRY_MS,
	wakeDeliveryId,
} from "../gateway/assistant/wakeRunner.js";
import type { WatcherEvent } from "../gateway/assistant/watcher.js";
import { DurableStore } from "../shared/durable-store.js";
import { fakeAmbient } from "../testing/fakeAmbient.js";

const T0 = 1_800_000_000_000;
const WAKES = { sort: () => ({ action: "wake" as const, ping: false, rulesRevision: 1 }), revision: 1 };

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function inboxWith(count: number): InboxStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-wake-"));
	dirs.push(dir);
	const inbox = createInboxStore(new DurableStore(dir, "assistant-inbox"));
	land(
		inbox,
		Array.from({ length: count }, (_, i) => `e${i}`),
		T0,
	);
	return inbox;
}

function land(inbox: InboxStore, ids: string[], now: number): void {
	const events: WatcherEvent[] = ids.map((sourceId) => ({ sourceId, at: 1, title: sourceId, fields: {} }));
	inbox.commitPoll("github", { kind: "events", events, cursor: "c", nextPollMs: 60_000 }, now, WAKES);
}

/** Fake send path. */
function sendPath() {
	const sent: { deliveryId: string; body: string }[] = [];
	const outcomes: (string | Error)[] = [];
	let hold: Promise<void> | null = null;
	let calls = 0;
	const wake: AssistantWake = async (event) => {
		calls += 1;
		if (hold) await hold;
		const next = outcomes.shift();
		if (next instanceof Error) throw next;
		if (next) return next;
		const composed = event.compose();
		if (composed) sent.push(composed);
		return null;
	};
	let release = () => undefined as void;
	const holdNext = () => {
		hold = new Promise<void>((resolve) => {
			release = () => {
				hold = null;
				resolve();
			};
		});
	};
	return { wake, sent, outcomes, holdNext, release: () => release(), calls: () => calls };
}

function runnerOver(inbox: InboxStore, ready = () => true) {
	const ambient = fakeAmbient({ drive: "manual", now: () => T0 });
	const runner = createWakeRunner({
		ambient,
		inbox,
		to: "host.assistant",
		ready,
		render: (batch) => batch.map((event) => `watcher: ${event.sourceId}`).join("\n\n"),
	});
	return { runner, ambient };
}

describe("the assistant's wake runner", () => {
	it("retries a failed wake on its own doubling backoff, and starts again from the floor once one lands", async () => {
		const inbox = inboxWith(1);
		const { runner, ambient } = runnerOver(inbox);
		const send = sendPath();
		send.outcomes.push("offline", new Error("queue write threw"));

		runner.bind(send.wake);
		await ambient.advance(0);
		await ambient.advance(WAKE_RETRY_MS - 1);
		const beforeFirstRetry = send.calls();
		await ambient.advance(1);
		await ambient.advance(2 * WAKE_RETRY_MS - 1);
		const beforeSecondRetry = send.calls();
		await ambient.advance(1);
		const landed = send.sent.length;
		land(inbox, ["late"], T0);
		send.outcomes.push("offline");
		runner.nudge();
		await ambient.advance(0);
		await ambient.advance(WAKE_RETRY_MS);
		await runner.stop();

		expect([beforeFirstRetry, beforeSecondRetry, landed]).toEqual([1, 2, 1]);
		expect(send.calls()).toBe(5);
		expect(inbox.pendingWakes(T0)).toEqual([]);
	});

	it("wakes on the first nudge once ready, after a bind that came before it", async () => {
		const inbox = inboxWith(1);
		let started = false;
		const { runner, ambient } = runnerOver(inbox, () => started);
		const send = sendPath();

		runner.bind(send.wake);
		started = true;
		runner.nudge();
		await ambient.advance(0);
		await runner.stop();

		expect(send.sent).toHaveLength(1);
	});

	it("sends nothing the assistant read while the session was being reached", async () => {
		const inbox = inboxWith(1);
		const { runner, ambient } = runnerOver(inbox);
		const send = sendPath();
		send.holdNext();

		runner.bind(send.wake);
		await ambient.advance(0);
		inbox.confirm(inbox.flush(undefined, T0).boundaries, T0);
		send.release();
		await ambient.advance(0);
		await runner.stop();

		expect(send.sent).toEqual([]);
		expect(inbox.events("github", T0).map((row) => row.disposition)).toEqual(["inbox"]);
	});

	it("carries at most a batch a push, oldest first, under an id its rows derive", async () => {
		const inbox = inboxWith(WAKE_BATCH + 5);
		const { runner, ambient } = runnerOver(inbox);
		const send = sendPath();

		runner.bind(send.wake);
		await ambient.advance(0);
		await runner.stop();

		const firstRows = Array.from({ length: WAKE_BATCH }, (_, i) => ({ watcherId: "github", sourceId: `e${i}` }));
		expect(send.sent.map((push) => push.body.split("\n\n").length)).toEqual([WAKE_BATCH, 5]);
		expect(send.sent[0]?.body.startsWith("watcher: e0")).toBe(true);
		expect(send.sent[0]?.deliveryId).toBe(wakeDeliveryId(firstRows));
		expect(inbox.pendingWakes(T0)).toEqual([]);
	});

	it("is final once stopped: a wake landing after it writes nothing, and no retry fires", async () => {
		const inbox = inboxWith(1);
		const { runner, ambient } = runnerOver(inbox);
		const send = sendPath();
		send.holdNext();

		runner.bind(send.wake);
		await ambient.advance(0);
		const stopping = runner.stop();
		send.release();
		await stopping;
		await ambient.advance(WAKE_RETRY_MS * 4);

		expect(send.calls()).toBe(1);
		expect(inbox.pendingWakes(T0).map((row) => row.sourceId)).toEqual(["e0"]);
	});
});
