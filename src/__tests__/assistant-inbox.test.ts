import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	createInboxStore,
	DROP_CAP,
	DROP_RETENTION_MS,
	INBOX_CAP,
	INBOX_RETENTION_MS,
	type Sorter,
} from "../gateway/assistant/inboxStore.js";
import type { PollAnswer, WatcherEvent } from "../gateway/assistant/watcher.js";
import { DurableStore, DurableStoreInstalledError, openDurable } from "../shared/durable-store.js";
import type { RuleAction, RuleDecision } from "../shared/schemasAssistantRules.js";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function disk(): DurableStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-inbox-"));
	dirs.push(dir);
	return new DurableStore(dir, "assistant-inbox");
}

function event(sourceId: string, fields: Record<string, string> = {}): WatcherEvent {
	return { sourceId, at: 1, title: `title ${sourceId}`, fields };
}

function polled(events: WatcherEvent[], cursor: string | null = "c1"): PollAnswer {
	return { kind: "events", events, cursor, nextPollMs: 60_000 };
}

function decided(action: RuleAction, rulesRevision = 1): RuleDecision {
	return { action, ping: false, rulesRevision };
}

function sorter(sort: (row: WatcherEvent) => RuleDecision, revision = 1): Sorter {
	return { sort, revision };
}

const NO_RULES = sorter(() => decided("inbox", 0), 0);
const T0 = 1_800_000_000_000;

describe("the assistant inbox", () => {
	it("lands events, cursor and health in one write that a reopened store reads back", () => {
		const store = disk();
		const inbox = createInboxStore(store);

		const landed = inbox.commitPoll("github", polled([event("a"), event("b")], "c1"), T0, NO_RULES);
		const reopened = createInboxStore(store);

		expect(landed?.accepted.map((row) => [row.sourceId, row.seq])).toEqual([
			["a", 1],
			["b", 2],
		]);
		expect(reopened.stateOf("github", T0)).toMatchObject({
			cursor: "c1",
			lastSuccessAt: T0,
			nextPollAt: T0 + 60_000,
		});
		expect(reopened.unread("github", T0)).toBe(2);
	});

	it("ignores a replayed source id, even after its row has expired", () => {
		const inbox = createInboxStore(disk());
		inbox.commitPoll("github", polled([event("a")]), T0, NO_RULES);

		const replay = inbox.commitPoll("github", polled([event("a"), event("b")]), T0 + 1, NO_RULES);
		const late = inbox.commitPoll("github", polled([event("a")]), T0 + INBOX_RETENTION_MS + 1, NO_RULES);

		expect(replay?.accepted.map((row) => row.sourceId)).toEqual(["b"]);
		expect(late?.accepted).toEqual([]);
		expect(inbox.events("github", T0 + 2).map((row) => row.sourceId)).toEqual(["b"]);
	});

	it("takes any source id as a plain key", () => {
		const inbox = createInboxStore(disk());
		const odd = [event("constructor"), event("__proto__"), event("toString")];

		const first = inbox.commitPoll("github", polled(odd), T0, NO_RULES);
		const again = inbox.commitPoll("github", polled(odd), T0 + 1, NO_RULES);

		expect(first?.accepted).toHaveLength(3);
		expect(again?.accepted).toEqual([]);
	});

	it("starts empty over a file it cannot read, and takes the next poll", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-inbox-"));
		dirs.push(dir);
		fs.writeFileSync(path.join(dir, "assistant-inbox.json"), JSON.stringify({ v: 1, events: "not a list" }));
		const inbox = openDurable(dir, "assistant-inbox", (store) => createInboxStore(store));

		const landed = inbox.commitPoll("github", polled([event("a")]), T0, NO_RULES);

		expect(landed?.accepted).toHaveLength(1);
		expect(inbox.events(undefined, T0)).toHaveLength(1);
	});

	it("keeps the old cursor and rows when the write does not land, and treats an installed one as landed", () => {
		const store = disk();
		let failure: Error | null = null;
		const flaky = Object.assign(Object.create(store), {
			saveChecked(state: unknown) {
				if (failure) throw failure;
				store.saveChecked(state);
			},
		}) as DurableStore;
		const inbox = createInboxStore(flaky);
		inbox.commitPoll("github", polled([event("a")], "c1"), T0, NO_RULES);

		failure = new Error("disk full");
		const refused = inbox.commitPoll("github", polled([event("b")], "c2"), T0 + 1, NO_RULES);
		failure = new DurableStoreInstalledError(new Error("dir sync"));
		const installed = inbox.commitPoll("github", polled([event("c")], "c3"), T0 + 2, NO_RULES);

		expect(refused).toBeNull();
		expect(installed?.accepted.map((row) => row.sourceId)).toEqual(["c"]);
		expect(inbox.events("github", T0 + 2).map((row) => row.sourceId)).toEqual(["a", "c"]);
		expect(inbox.stateOf("github", T0 + 2)?.cursor).toBe("c3");
	});

	it("evicts the oldest unread rows past the cap, counts them, and reports only what it kept", () => {
		const inbox = createInboxStore(disk());
		const many = Array.from({ length: INBOX_CAP + 3 }, (_, i) => event(`e${i}`));

		const landed = inbox.commitPoll("github", polled(many), T0, NO_RULES);

		expect(landed?.accepted).toHaveLength(INBOX_CAP);
		expect(landed?.accepted[0]?.sourceId).toBe("e3");
		expect(inbox.unread("github", T0)).toBe(INBOX_CAP);
		expect(inbox.stateOf("github", T0)?.evicted).toBe(3);
		expect(inbox.events("github", T0)[0]?.sourceId).toBe("e3");
	});

	it("restores a snapshot whose seq counter fell behind, and keeps rows in seq order", () => {
		const store = disk();
		const row = (sourceId: string, seq: number) => ({
			...event(sourceId),
			watcherId: "github",
			seq,
			receivedAt: T0,
			disposition: "inbox",
		});
		store.saveChecked({
			v: 1,
			nextSeq: 1,
			events: [row("late", 5), row("early", 1)],
			watchers: { github: { cursor: "c1", readSeq: 0, evicted: 0 } },
			seen: { github: { late: T0, early: T0 } },
		});
		const inbox = createInboxStore(store);

		const landed = inbox.commitPoll("github", polled([event("new")], "c2"), T0 + 1, NO_RULES);

		expect(landed?.accepted.map((accepted) => accepted.seq)).toEqual([6]);
		expect(inbox.events("github", T0 + 1).map((held) => held.sourceId)).toEqual(["early", "late", "new"]);
		expect(inbox.unread("github", T0 + 1)).toBe(3);
	});

	it("keeps a rule drop for its own window, shorter than the inbox's", () => {
		const inbox = createInboxStore(disk());
		inbox.commitPoll(
			"github",
			polled([event("kept"), event("dropped", { reason: "subscribed" })]),
			T0,
			sorter((row) => decided(row.fields.reason === "subscribed" ? "drop" : "inbox")),
		);

		inbox.commitPoll("github", polled([]), T0 + DROP_RETENTION_MS + 1, NO_RULES);
		const later = T0 + DROP_RETENTION_MS + 1;

		expect(inbox.events("github", later).map((row) => row.sourceId)).toEqual(["kept"]);
		expect(inbox.stateOf("github", later)?.evicted).toBe(0);
	});

	it("counts an expired unread row as lost as soon as it leaves unread, with no write", () => {
		const inbox = createInboxStore(disk());
		inbox.commitPoll("github", polled([event("a")]), T0, NO_RULES);
		const later = T0 + INBOX_RETENTION_MS + 1;

		expect(inbox.unread("github", later)).toBe(0);
		expect(inbox.stateOf("github", later)?.evicted).toBe(1);
	});

	it("sorts kept drops again under new rules, giving a caught one a fresh place in line", () => {
		const store = disk();
		const inbox = createInboxStore(store);
		const subscribed = (row: WatcherEvent) => row.fields.reason === "subscribed";
		inbox.commitPoll(
			"github",
			polled([event("a", { reason: "subscribed" }), event("b")]),
			T0,
			sorter((row) => decided(subscribed(row) ? "drop" : "inbox")),
		);

		const landed = inbox.resort(
			"github",
			sorter(() => decided("wake", 2), 2),
			T0 + 1,
		);
		const reopened = createInboxStore(store);

		expect(landed).toBe(true);
		expect(
			reopened.events("github", T0 + 1).map((row) => [row.sourceId, row.disposition, row.decision?.action]),
		).toEqual([
			["b", "inbox", "inbox"],
			["a", "inbox", "wake"],
		]);
		expect(reopened.stateOf("github", T0 + 1)?.rulesRevision).toBe(2);
		expect(reopened.unread("github", T0 + 1)).toBe(2);
	});

	it("never sorts a drop past its 7 days again, nor counts it as lost", () => {
		const inbox = createInboxStore(disk());
		inbox.commitPoll(
			"github",
			polled([event("old")]),
			T0,
			sorter(() => decided("drop")),
		);
		const later = T0 + DROP_RETENTION_MS + 1;

		inbox.resort(
			"github",
			sorter(() => decided("inbox", 2), 2),
			later,
		);

		expect(inbox.events("github", later)).toEqual([]);
		expect(inbox.unread("github", later)).toBe(0);
		expect(inbox.stateOf("github", later)?.evicted).toBe(0);
	});

	it("catches up an inbox behind the rules in the next poll's write", () => {
		const inbox = createInboxStore(disk());
		inbox.commitPoll(
			"github",
			polled([event("a")], "c1"),
			T0,
			sorter(() => decided("drop")),
		);

		inbox.commitPoll(
			"github",
			polled([], "c2"),
			T0 + 1,
			sorter(() => decided("inbox", 2), 2),
		);

		expect(inbox.unread("github", T0 + 1)).toBe(1);
		expect(inbox.stateOf("github", T0 + 1)).toMatchObject({ cursor: "c2", rulesRevision: 2 });
	});

	it("caps kept drops per watcher without counting them as lost", () => {
		const inbox = createInboxStore(disk());
		const many = Array.from({ length: DROP_CAP + 2 }, (_, i) => event(`d${i}`));

		inbox.commitPoll(
			"github",
			polled(many),
			T0,
			sorter(() => decided("drop")),
		);

		expect(inbox.events("github", T0)).toHaveLength(DROP_CAP);
		expect(inbox.events("github", T0)[0]?.sourceId).toBe("d2");
		expect(inbox.stateOf("github", T0)?.evicted).toBe(0);
	});

	it("records backoff and stop without moving the cursor, and a good poll clears both", () => {
		const inbox = createInboxStore(disk());
		inbox.commitPoll("github", polled([], "c1"), T0, NO_RULES);

		inbox.commitPoll("github", { kind: "backoff", retryMs: 5_000, reason: "rate limited" }, T0 + 1, NO_RULES);
		const backedOff = inbox.stateOf("github", T0 + 1);
		inbox.commitPoll("github", { kind: "stopped", reason: "needs a secret" }, T0 + 2, NO_RULES);
		const stopped = inbox.stateOf("github", T0 + 2);
		inbox.commitPoll("github", polled([], "c2"), T0 + 3, NO_RULES);

		expect(backedOff).toMatchObject({ cursor: "c1", backoff: { reason: "rate limited" }, nextPollAt: T0 + 5_001 });
		expect(stopped).toMatchObject({ cursor: "c1", stopped: "needs a secret" });
		expect(stopped?.nextPollAt).toBeUndefined();
		expect(inbox.stateOf("github", T0 + 3)).toMatchObject({ cursor: "c2" });
		expect(inbox.stateOf("github", T0 + 3)?.stopped).toBeUndefined();
		expect(inbox.stateOf("github", T0 + 3)?.backoff).toBeUndefined();
	});
});
