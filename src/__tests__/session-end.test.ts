import { describe, expect, it } from "vitest";
import { createSessionEnd, purgeItemsOf, type SessionEndDeps } from "../gateway/sessionEnd.js";
import type { SessionRecord } from "../shared/session-store.js";

const CONVERSATION = "123e4567-e89b-42d3-a456-426614174000";
const PANE = { kind: "host", name: "host", sessionName: "abc123" } as const;
const HOST = { kind: "host", workdirHint: "~/work" } as const;

function record(over: Partial<SessionRecord> = {}): SessionRecord {
	return {
		id: "abc123",
		sessionLabel: "Work",
		spawn: "host",
		harness: "claude",
		claudeSessionId: CONVERSATION,
		lastSeen: 0,
		...over,
	};
}

const BOX = { kind: "devcontainer", project: "recipe-app", hostProjectPath: "/projects/recipe-app" } as const;

function deps(threads: string[] = [], requestedTarget: typeof HOST | typeof BOX = HOST) {
	return {
		sessionStore: {
			getByTeam: () => undefined,
			teamOf: (held: SessionRecord) => `${held.spawn}.${held.id}`,
			hostWorkdirHint: () => "~/work",
			everyAgent: () =>
				threads.map((sessionId) => ({
					backend: "codex" as const,
					agent: { sessionId, requestedTarget },
				})) as ReturnType<SessionEndDeps["sessionStore"]["everyAgent"]>,
		},
	};
}

describe("what a record leaves at its place", () => {
	it("is its conversation and own files behind its pane, then each agent's thread", () => {
		const own = { ...HOST, spawn: "host" };

		expect(purgeItemsOf(record(), deps(["thread-1"]))).toEqual([
			{ place: own, what: { kind: "claude", conversationId: CONVERSATION }, pane: PANE },
			{ place: own, what: { kind: "files", session: PANE }, pane: PANE },
			{ place: HOST, what: { kind: "thread", backend: "codex", threadId: "thread-1" } },
		]);
	});

	it("deletes a minted conversation through its CLI's own backend", () => {
		const items = purgeItemsOf(record({ harness: "opencode", mintedSessionId: "ses_sb1" }), deps());

		expect(items[0]?.what).toEqual({ kind: "thread", backend: "opencode", threadId: "ses_sb1" });
	});

	it("names the spawn point whose home holds a host session's things, and no thread a driver cannot reach there", () => {
		const windows = { ...HOST, spawn: "windows" };
		const pane = { ...PANE, name: "windows" };

		expect(purgeItemsOf(record({ spawn: "windows" }), deps())).toEqual([
			{ place: windows, what: { kind: "claude", conversationId: CONVERSATION }, pane },
			{ place: windows, what: { kind: "files", session: pane }, pane },
		]);
		const copilot = record({ spawn: "windows", harness: "copilot", mintedSessionId: CONVERSATION });
		expect(purgeItemsOf(copilot, deps()).map((item) => item.what.kind)).toEqual(["files"]);
	});

	it("names no conversation whose id is not one, and still deletes the session's own files", () => {
		const items = purgeItemsOf(record({ claudeSessionId: "../../etc" }), deps());

		expect(items.map((item) => item.what.kind)).toEqual(["files"]);
	});

	it("leaves a terminal another name runs in, and still deletes the agents' threads", () => {
		const foreign = record({ liveTeam: { team: "host.other", subId: "s" } });

		expect(purgeItemsOf(foreign, deps(["thread-1"])).map((item) => item.what.kind)).toEqual(["thread"]);
	});

	it("names a container by its project alone, with no catalog to read, and an agent's thread where the agent ran", () => {
		const boxed = record({ spawn: "recipe-app" });

		expect(purgeItemsOf(boxed, deps(["thread-1"], BOX))).toMatchObject([
			{
				place: { kind: "devcontainer", project: "recipe-app" },
				pane: { kind: "devcontainer", name: "recipe-app", sessionName: "abc123" },
			},
			{ what: { kind: "files" } },
			{ place: { kind: "devcontainer", project: "recipe-app" }, what: { kind: "thread" } },
		]);
	});
});

describe("the one end of a session", () => {
	it("reads the ids, removes the record, queues, saves, then tells the rest, in that order", () => {
		const log: string[] = [];
		const held = record();
		let present = true;
		const end = createSessionEnd({
			...deps(["thread-1"]),
			sessionStore: { ...deps(["thread-1"]).sessionStore, getByTeam: () => (present ? held : undefined) },
			forget: () => {
				log.push("forget");
				present = false;
				return true;
			},
			purges: {
				add: (items) => {
					log.push(`queue ${items.length}`);
					return [...items];
				},
			},
			save: () => log.push("save"),
			before: (_team, disposition) => log.push(`before ${disposition}`),
			ended: () => log.push("ended"),
		});

		expect(end("host.abc123", "cancel")).toBe(true);
		expect(log).toEqual(["before cancel", "forget", "queue 3", "save", "ended"]);
	});

	it("queues and saves nothing for a name no record holds, and still tells the rest", () => {
		const log: string[] = [];
		const end = createSessionEnd({
			...deps(),
			forget: () => false,
			purges: {
				add: (items) => {
					log.push("queue");
					return [...items];
				},
			},
			save: () => log.push("save"),
			before: () => log.push("before"),
			ended: () => log.push("ended"),
		});

		expect(end("host.gone")).toBe(false);
		expect(log).toEqual(["before", "ended"]);
	});
});
